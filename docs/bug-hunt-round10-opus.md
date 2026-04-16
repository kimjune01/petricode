# Bug Hunt Round 10 (opus)

2 new bugs found. Tests: 204 pass / 0 fail.

---

## Bug 1: `expandFileRefs` resolves paths against `process.cwd()` instead of `projectDir`

- **Severity:** medium
- **File:** `src/perceive/fileRefs.ts:24-26`

### Description
`expandFileRefs(input, projectDir)` validates each `@path` against `projectDir` via `validateFilePath(filePath, projectDir)`, but then reads the file with `await readFile(filePath, "utf-8")`. Node's `fs/promises.readFile` resolves relative paths against `process.cwd()`, not `projectDir`.

```ts
if (validateFilePath(filePath, projectDir)) continue;
try {
  const contents = await readFile(filePath, "utf-8");
  replacements.set(fullMatch, `\n<file path="${filePath}">\n${contents}\n</file>`);
```

When the user launches petricode from a directory other than `projectDir` (e.g. from `$HOME` while `projectDir` is some sub-project), the validator green-lights `@README.md` because `path.resolve(projectDir, "README.md")` is inside `projectDir`, but `readFile("README.md", ...)` actually opens `$HOME/README.md`.

### Impact
- **Wrong file inlined.** `@README.md` from a chat in `~/ea/petricode/sub-project` while launched from `~/ea` will splice the contents of `~/ea/README.md` (or whatever the current shell cwd contains) into the user's message — under a `<file path="README.md">` tag that misleadingly claims it came from the project.
- **Path-traversal partial bypass.** The validator's job is to keep file inlining inside `projectDir`. Because the read uses a different base, a `@somefile` that exists only outside `projectDir` (but happens to have a name that *could* live inside `projectDir`) will be read and inlined despite never existing in the project.
- Same root cause as Round 9 #1 (tool cwd hijack) but in a different code path; the Round 9 fix only patched `tools/*` and `toolSubpipe.ts`, not `perceive/fileRefs.ts`.

### Suggested fix
Resolve `filePath` against `projectDir` before reading:

```ts
import { resolve } from "path";
// ...
if (validateFilePath(filePath, projectDir)) continue;
const absPath = resolve(projectDir, filePath);
try {
  const contents = await readFile(absPath, "utf-8");
```

Add a regression test that runs `expandFileRefs("@x.txt", projectDir)` from a `process.chdir(otherDir)` where `otherDir/x.txt` exists but `projectDir/x.txt` does not — it should not inline anything.

---

## Bug 2: `TfIdfIndex.documents` grows unboundedly; `remove_document` never called on cluster eviction

- **Severity:** low / medium (slow leak; degrades IDF quality over long sessions)
- **Files:**
  - `src/cache/tfidf.ts:28-41` (defines `add_document` / `remove_document`)
  - `src/cache/compaction.ts:50` (calls `add_document` on every graduate)
  - `src/cache/compaction.ts:90` (`forest.remove(lru_root.id)` on eviction — no matching `index.remove_document`)

### Description
Every call to `graduate()` invokes `index.add_document(text)`, which appends raw token arrays to `TfIdfIndex.documents`. When `enforce_cap` evicts an LRU cluster via `forest.remove(lru_root.id)`, the corresponding token arrays in the TF-IDF index are **never removed**. `remove_document(index)` exists and is exported, but it has zero call sites in `src/`.

Confirmed: `Grep "remove_document"` in `src/` only matches the definition.

### Impact
- **Memory leak.** Every graduated turn appends a token array that is never freed. In a long session (hundreds of turns), `documents` grows unboundedly even though `forest.root_count()` is capped at `max_clusters`.
- **Skewed IDF / degraded clustering.** `recompute_idf()` uses `n = this.documents.length` as the document count denominator. Evicted documents still inflate `n` and `doc_freq` for terms that no longer exist in any live cluster. The IDF weights for terms that appeared in evicted documents will be artificially deflated, while terms exclusive to live clusters get less differentiation. Over a long session this makes `vectorize()` produce vectors that don't accurately reflect the current cold-zone corpus, which feeds back into `nearest_root()` and degrades merge decisions.
- **Slow, not catastrophic.** Token arrays are small per turn, so the leak is subtle — it shows up as gradually worse clustering quality and creeping memory in 1000+ turn sessions.

### Suggested fix
Track the document index returned by `add_document` per turn (e.g. on the `forest` node or in a side-map keyed by root id), and call `index.remove_document(idx)` for each turn in the cluster being evicted.

Sketch:

```ts
// in compaction.ts graduate():
const doc_idx = index.add_document(text);
forest.add(turn.id, vector, [turn], doc_idx);  // store on node

// in enforce_cap, before forest.remove(lru_root.id):
for (const member of forest.members(lru_root.id)) {
  if (member.doc_idx !== undefined) index.remove_document(member.doc_idx);
}
forest.remove(lru_root.id);
```

When merging via `union()`, the merged-in doc indices need to be carried onto the surviving root so that future evictions still cover them.

Add a regression test: append > `max_clusters` distinct turns and assert `index.document_count()` minus the number of tombstones reflects only the live clusters' member count.
