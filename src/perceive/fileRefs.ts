import { open, stat } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { validateFilePath } from "../filter/pathValidation.js";

// Negative-lookbehind for word chars rejects `email@domain.com` while
// still allowing `(@foo)`, `"@foo"`, `[@foo]` — common when users
// quote a path. Word boundary (\w) catches A-Z a-z 0-9 _, which is the
// "username" half of an email; punctuation/whitespace passes through.
const FILE_REF_PATTERN = /(?<!\w)@([^\s]+)/g;
// Mirrors ReadFileTool's MAX_READ_BYTES so an `@huge.log` mention can't
// dump unbounded bytes into the prompt — the per-tool cap meant nothing
// when fileRefs.ts inlined files via raw readFile().
const MAX_READ_BYTES = 262_144; // 256 KB

/**
 * Expand @path references in input text by inlining file contents.
 *
 * Paths must resolve inside `projectDir` — anything outside (e.g. @/etc/passwd,
 * @~/.ssh/id_rsa) is silently left as-is. Read failures are also silent so a
 * stray @-mention in pasted text doesn't reveal whether a file exists.
 */
export async function expandFileRefs(input: string, projectDir: string): Promise<string> {
  const matches = [...input.matchAll(FILE_REF_PATTERN)];
  if (matches.length === 0) return input;

  // Build replacement map in one pass to avoid global replace on evolving output
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const fullMatch = match[0]!;
    if (replacements.has(fullMatch)) continue;
    const rawPath = match[1]!;
    // Trailing closers — `)`, `]`, `}`, `"`, `'`, `>` — handle the
    // wrapping case `(@src/foo.ts)` where the relaxed lookbehind lets
    // the `(` pass but the `)` lands at the end of the match. Without
    // stripping it we'd look up `src/foo.ts)` and silently leave the
    // mention as-is. Sentence-end punctuation kept from the original.
    const trailingMatch = rawPath.match(/[.,;:!?)\]}>"'`]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    // Leading openers handle `@"src/foo.ts"` style references, where
    // the user puts the @ outside the quote. Captured as `"src/foo.ts"`,
    // trailing strip removes `"`, but the leading `"` would still poison
    // the lookup path. Strip mirrored opener punctuation.
    const leadingMatch = rawPath.match(/^["'(\[{<`]+/);
    const leading = leadingMatch ? leadingMatch[0] : "";
    const trimmedRaw = trailing ? rawPath.slice(0, -trailing.length) : rawPath;
    const filePath = leading ? trimmedRaw.slice(leading.length) : trimmedRaw;
    if (validateFilePath(filePath, projectDir)) continue;
    // validateFilePath confirms projectDir-relative resolution stays inside
    // projectDir, but readFile resolves relative paths against process.cwd().
    // If petricode was launched from outside projectDir, that mismatch would
    // splice the wrong file's contents under a misleading <file path="..."> tag.
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
    try {
      const stats = await stat(absPath);
      // Skip non-regular files. Opening a FIFO or character device
      // (e.g. an `@/dev/urandom` mention slipping past validation in a
      // weird projectDir) would block readFile() forever and hang the
      // whole agent.
      if (!stats.isFile()) continue;
      const fh = await open(absPath, "r");
      let contents: string;
      try {
        // Sniff the head for NUL bytes to detect binary content. PNGs,
        // executables, sqlite dbs etc. will otherwise dump 256KB of
        // U+FFFD-mangled garbage into the prompt, evicting useful
        // context. We read up to MAX_READ_BYTES once and decide based
        // on the prefix; small files are returned verbatim.
        // Virtual files (e.g. /proc/cpuinfo, sysfs entries, FUSE mounts)
        // report stats.size === 0 but yield real content on read. Cap
        // by MAX_READ_BYTES rather than stats.size when size is 0 so
        // those don't get inlined as empty strings.
        const bufSize = stats.size > 0
          ? Math.min(stats.size, MAX_READ_BYTES)
          : MAX_READ_BYTES;
        const buf = Buffer.alloc(bufSize);
        const { bytesRead } = await fh.read(buf, 0, bufSize, 0);
        const head = buf.slice(0, Math.min(bytesRead, 4096));
        if (head.indexOf(0) !== -1) continue; // binary — skip silently
        // Truncating exactly at MAX_READ_BYTES can bisect a multibyte
        // UTF-8 sequence, leaving a trailing replacement char right
        // before the truncation marker. TextDecoder with stream:true
        // buffers the partial trailing bytes instead of decoding them
        // to U+FFFD; for non-truncated files it behaves identically to
        // a plain toString.
        // Truncation flag based on bytesRead, not stats.size — virtual
        // files report size 0 but can fill the buffer, so a stats-only
        // check would silently drop trailing bytes without marking the
        // truncation. If bytesRead hit the cap, we treat the read as
        // potentially truncated.
        const truncated = bytesRead >= MAX_READ_BYTES;
        const decoder = new TextDecoder("utf-8");
        const decoded = decoder.decode(
          buf.slice(0, bytesRead),
          { stream: truncated },
        );
        contents = truncated
          ? stats.size > 0
            ? `${decoded}\n[truncated — file is ${stats.size} bytes, showing first ${MAX_READ_BYTES}]`
            : `${decoded}\n[truncated — showing first ${MAX_READ_BYTES} bytes]`
          : decoded;
      } finally {
        await fh.close();
      }
      // Reattach the leading and trailing punctuation we stripped from
      // the path — otherwise `What about @README.md, @LICENSE?` would
      // lose the comma and question mark, and `@"foo"` would lose its
      // quotes from the user's prose.
      replacements.set(
        fullMatch,
        `${leading}\n<file path="${filePath}">\n${contents}\n</file>${trailing}`,
      );
    } catch {
      // Do nothing, leave as-is
    }
  }

  // Single-pass replacement using the pattern
  return input.replace(FILE_REF_PATTERN, (fullMatch) => {
    return replacements.get(fullMatch) ?? fullMatch;
  });
}
