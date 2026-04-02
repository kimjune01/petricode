# claude-left

AGPL-3.0 spec for a coding agent harness derived from the Natural Framework.

## Provenance

This spec is NOT derived from any proprietary source code. It follows from:
- The Natural Framework's six roles (june.kim/the-natural-framework)
- Diagnosis LLM (june.kim/diagnosis-llm)
- SOAP diagnostic pipeline applied to gemini-cli (Apache 2.0 source)
- gemini-cli GitHub issues/PRs (public)

Do NOT reference, copy from, or read any proprietary source code (Claude Code, leaked or otherwise). The spec must be independently derivable from the framework.

## Structure

- `spec/` — nine specification documents, one per role plus architecture, composition, and anti-patterns
- `LICENSE` — AGPL-3.0
- `README.md` — provenance, structure, rationale

## Editing

Specs describe what a correct pipe MUST have, derived from the framework's structural requirements. When adding to the spec, cite the framework concept (role, tower level, invariant) — not any vendor's implementation.
