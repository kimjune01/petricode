# Bug Hunt Round 54

Three new bugs found.

## Triage outcome

- **#1 (move-to-trash never offered in cautious TUI)** — FIXED in `src/agent/toolSubpipe.ts`. Collapsed the dangerous-shell check condition so it runs whenever a shell call is `policyOutcome === "ASK_USER"`, regardless of whether `onConfirm` is set. Pre-fix the cautious TUI path (ASK_USER + onConfirm) was missing, so `dangerReason` stayed undefined, and the trash-alternative gate at line ~422 silently skipped — default-mode users only saw allow/deny on `rm -rf` and had to manually request a safer form.
- **#2 (realpathSync called redundantly per ancestor-walk iteration)** — DEFERRED. Pure perf, not severe (per scope rules). The redundant syscall costs N stat calls instead of 1 in a deep symlink chain — measurable on slow remote FS but no correctness impact and well outside the "user would actually hit" priority.
- **#3 (JSDoc misstates project-root relevance score)** — FIXED in `src/perceive/contextDiscovery.ts`. Updated comment to read `global (0.3) < project root (0.5) < project .agents/ (0.7) < subdirectory .agents/ (0.9)`. Code at line 39 already assigned 0.5; only the doc was wrong.

2 regression tests added; full suite 429 pass (was 427).

---

## BUG-1 (med) — "Move to trash" alternative never offered in cautious TUI mode

**File:** `src/agent/toolSubpipe.ts:322–336` and `:422–427`

**Mechanism:**  
`dangerReason` (the prerequisite for offering the soft-delete alternative) is only populated when the dangerous-shell check runs. That check fires under two conditions:

```typescript
if (
  tc.name === "shell"
  && (
    (permissiveShellGuard && policyOutcome === "ALLOW")   // permissive mode
    || (policyOutcome === "ASK_USER" && !onConfirm)       // headless
  )
) {
  const verdict = isDangerousShell(...);
  if (verdict.dangerous) dangerReason = verdict.reason;
}
```

In the default cautious TUI mode: `permissiveShellGuard = false` and `onConfirm` is set, so **neither condition is ever true**. `dangerReason` stays `undefined`.

The alternative is gated further down at line 422–427:

```typescript
if (dangerReason && tc.name === "shell" && sessionId && /\brm\b/.test(dangerReason)) {
  // ... build ConfirmAlternative with rewriteRmToMv ...
}
```

Because `dangerReason` is never set in cautious TUI mode, `alternative` is always `undefined` and the "move to trash" prompt is **never shown to users in the default mode**.

**User-visible impact:**  
A user in cautious mode (the default) who sees an `rm -rf build/` confirmation prompt gets only allow/deny. They have to deny, then manually ask the model for a safer approach. The "move to trash" feature silently works only in `--permissive` mode.

**Suggested fix:**  
Also run `isDangerousShell` in the `policyOutcome === "ASK_USER" && onConfirm` path (cautious TUI mode) to populate `dangerReason` for the alternative check — without changing `policyOutcome`, so it doesn't alter the confirmation requirement:

```typescript
if (
  tc.name === "shell"
  && (
    (permissiveShellGuard && policyOutcome === "ALLOW")
    || (policyOutcome === "ASK_USER" && !onConfirm)
    || (policyOutcome === "ASK_USER" && !!onConfirm)  // cautious TUI — for alternative only
  )
) {
  const verdict = isDangerousShell(...);
  if (verdict.dangerous) {
    if (permissiveShellGuard && policyOutcome === "ALLOW") policyOutcome = "ASK_USER";
    dangerReason = verdict.reason;
  }
}
```

**Severity:** med — Default mode users are silently missing a feature.

---

## BUG-2 (low) — `realpathSync(resolvedProject)` called redundantly every ancestor-walk iteration

**File:** `src/filter/pathValidation.ts:132`

```typescript
} catch {
  let ancestor = dirname(resolvedPath);
  while (ancestor !== dirname(ancestor)) {
    try {
      const realAncestor = realpathSync(ancestor);
      const realProject = realpathSync(resolvedProject);  // ← redundant each iteration
      if (!realAncestor.startsWith(realProject + sep) && realAncestor !== realProject) {
        return { ... };
      }
      break;
    } catch {
      ancestor = dirname(ancestor);
    }
  }
}
```

`resolvedProject` is a constant within `validateFilePath`. The outer `try` block (line 115) already resolved it once. The inner loop re-resolves it on every iteration.

**User-visible impact:**  
None functionally. Pure performance: for a deeply nested path pointing outside the project (e.g. a symlink chain 10 levels deep), `realpathSync` fires 10× on the same path instead of once. Each call is a synchronous stat syscall; on a slow or remote FS this compounds.

**Suggested fix:**  
Resolve `realProject` once before both try blocks and reuse it:

```typescript
const realProject = (() => { try { return realpathSync(resolvedProject); } catch { return resolvedProject; } })();
```

**Severity:** low — No correctness impact; perf only.

---

## BUG-3 (low) — JSDoc comment misstates project-root relevance score

**File:** `src/perceive/contextDiscovery.ts:15`

```typescript
/**
 * Discover context fragments by walking for instruction files.
 * Precedence: global (0.3) < project (0.7) < subdirectory (0.9).
 */
```

The actual code at line 39:

```typescript
fragments.push({ source: p, content, relevance: 0.5 });
```

The comment claims project-root fragments have relevance `0.7`; the code assigns `0.5`. The actual ordering is `0.3 < 0.5 < 0.7 < 0.9`, not the stated `0.3 < 0.7 < 0.9`.

**User-visible impact:**  
A developer reading the comment and writing tests or tooling against the stated precedence table gets wrong values. The sort order is correct (`0.5` still falls between global `0.3` and `.agents/` `0.7`), so the functional behavior matches intent — just the documented number is wrong.

**Suggested fix:**  
Update the JSDoc to read `global (0.3) < project (0.5) < .agents/ (0.7) < subdirectory .agents/ (0.9)`.

**Severity:** low — Documentation only; no runtime impact.
