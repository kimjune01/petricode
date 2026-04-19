import { open, readdir, stat } from "fs/promises";
import { join } from "path";
import type { ContextFragment } from "../core/types.js";
import { isAlwaysExcluded, loadIgnorePredicate } from "../filter/gitignore.js";

const INSTRUCTION_FILES = ["instructions.md", "CLAUDE.md", "AGENTS.md", "README.md"];
// Cap reads so a stray 50MB file in `.agents/` (training corpus,
// pasted log, etc.) can't OOM the agent or blow past the provider
// context window on every turn — discoverContext runs per perceive,
// so the cost compounds. Matches readFile.ts and fileRefs.ts.
const MAX_READ_BYTES = 262_144;

/**
 * Discover context fragments by walking for instruction files.
 * Precedence: global (0.3) < project root (0.5) < project .agents/
 * (0.7) < subdirectory .agents/ (0.9).
 */
export async function discoverContext(
  projectDir: string,
  globalConfigDir?: string
): Promise<ContextFragment[]> {
  const fragments: ContextFragment[] = [];

  // Global config
  if (globalConfigDir) {
    for (const file of INSTRUCTION_FILES) {
      const p = join(globalConfigDir, file);
      const content = await tryRead(p);
      if (content !== null) {
        fragments.push({ source: p, content, relevance: 0.3 });
      }
    }
  }

  // Project-root instruction files (CLAUDE.md, AGENTS.md, etc.)
  for (const file of INSTRUCTION_FILES) {
    const p = join(projectDir, file);
    const content = await tryRead(p);
    if (content !== null) {
      fragments.push({ source: p, content, relevance: 0.5 });
    }
  }

  // Project-level .agents/
  const projectAgents = join(projectDir, ".agents");
  await collectFromDir(projectAgents, fragments, 0.7);

  // Subdirectory .agents/ — one level deep. Skip always-excluded dirs
  // AND anything the project's own .gitignore opts out of, so we don't
  // walk into `vendor/`, `dist/`, or any user-defined ignore dir
  // chasing context fragments that don't exist.
  try {
    const isIgnored = await loadIgnorePredicate(projectDir);
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (isAlwaysExcluded(entry.name)) continue;
      if (isIgnored(entry.name, true)) continue;
      const subAgents = join(projectDir, entry.name, ".agents");
      await collectFromDir(subAgents, fragments, 0.9);
    }
  } catch {
    // projectDir might not exist
  }

  // Sort by relevance ascending (global first, subdirectory last)
  fragments.sort((a, b) => a.relevance - b.relevance);

  return fragments;
}

async function collectFromDir(
  dir: string,
  fragments: ContextFragment[],
  relevance: number
): Promise<void> {
  try {
    const entries = await readdir(dir);
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const p = join(dir, file);
      const content = await tryRead(p);
      if (content !== null) {
        fragments.push({ source: p, content, relevance });
      }
    }
  } catch {
    // dir doesn't exist — fine
  }
}

async function tryRead(path: string): Promise<string | null> {
  let fh;
  // stat first so we can disambiguate "file is exactly MAX_READ_BYTES
  // on disk" from "first MAX_READ_BYTES of a larger file" — both fill
  // the buffer to the brim, but only the latter actually truncated.
  // Mirrors readFile.ts. If stat fails (race / permissions), fall back
  // to size 0 which means "treat any cap-filling read as truncated".
  let statSize = 0;
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    statSize = st.size;
  } catch {
    // tolerate — fh.open below will report the real failure
  }
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_READ_BYTES, 0);
    // Mirror readFile.ts: sniff the first 4096 bytes for NUL and
    // refuse on binary content. A CLAUDE.md or .agents/* file
    // accidentally overwritten by a build artifact (sqlite db, png,
    // compiled binary) would otherwise be decoded as UTF-8 garbage
    // and silently injected into the system context every turn.
    const head = buf.slice(0, Math.min(bytesRead, 4096));
    if (head.indexOf(0) !== -1) return null;
    // Same gate for the truncation flag and the TextDecoder stream
    // mode: `stream: true` buffers an incomplete trailing UTF-8
    // sequence (we'd flush it on the next decode call), but for an
    // exact-cap file we never call decode again, so the partial
    // codepoint silently disappears. Match the truncated condition
    // so stream-mode only kicks in for genuine overflows. Mirrors
    // readFile.ts and fileRefs.ts.
    const truncated =
      bytesRead >= MAX_READ_BYTES &&
      !(statSize > 0 && statSize <= MAX_READ_BYTES);
    const decoded = new TextDecoder("utf-8").decode(
      buf.slice(0, bytesRead),
      { stream: truncated },
    );
    // Strip a leading UTF-8 BOM so files saved by Windows editors
    // (Notepad, VS Code with BOM-on-save) don't inject U+FEFF as the
    // first character of the model's system context. Mirrors the
    // BOM strip in skiller/perceive.ts.
    const clean = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
    return truncated
      ? `${clean}\n[truncated — context fragment exceeded ${MAX_READ_BYTES} bytes]`
      : clean;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}
