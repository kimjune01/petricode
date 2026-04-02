# 04 — Skills

Procedural memory for the harness. Skills are reusable procedures that change how the agent filters, attends, and responds in future sessions. They are the bridge between Consolidate (writes skills) and Perceive (loads skills).

## What a skill is

A skill is a markdown file with YAML frontmatter. It specifies:
- **When** to activate (trigger condition)
- **What** to inject (system context, tool restrictions, behavioral guidance)
- **How** to invoke (slash command, automatic activation, or both)

Skills are the agent's procedural memory — the output of learning. A harness without skills can execute. A harness with skills can improve.

## Format

```markdown
---
name: tighten
description: Compress each paragraph without losing argument
trigger: slash          # slash | auto | both
allowed-tools: Read, Edit, Grep, Glob
---

# Tighten

Cut filler, merge redundant sentences, shorten. Preserve argument structure.

## Process

1. Read the file
2. For each paragraph, compress without losing claims
3. Report what was cut and why
```

### Frontmatter fields

| Field | Required | Values | Description |
|-------|----------|--------|-------------|
| `name` | yes | string | Unique identifier. Used as slash command name. |
| `description` | yes | string (≤250 chars) | One-line description. Injected into system context for discoverability. |
| `trigger` | yes | `slash` \| `auto` \| `both` | `slash`: invoked via `/name`. `auto`: activates when conditions match. `both`: either. |
| `allowed-tools` | no | comma-separated tool names | Restricts which tools the skill can use. Omit for all tools. |
| `paths` | no | glob pattern or YAML list | Only activate when the agent touches files matching these patterns. |
| `model` | no | string | Override model for this skill (e.g., use a cheaper model for mechanical work). |

### Body

The body is the skill's system prompt. It describes what to do, how to do it, and what to check. The body is injected into the model's context when the skill activates.

## Discovery

Skills are discovered from these locations, in precedence order (later overrides earlier):

```
~/.config/petricode/skills/        ← global (user-wide)
project/.agents/skills/            ← project-level
project/.agents/skills/<name>/     ← skill with subdirectory (for multi-file skills)
```

Discovery happens at session start and on `/skills` refresh. Each skill directory is scanned for `*.md` files with valid frontmatter.

**Naming conflicts:** if two skills share a name, the more specific scope wins (project > global).

## Activation

### Slash command (`trigger: slash` or `both`)

User types `/tighten` (or `/tighten path/to/file`). The skill's body is injected as system context for the current turn. Arguments are passed as `$ARGUMENTS` in the body.

### Automatic (`trigger: auto` or `both`)

When `paths` is set, the skill activates automatically when the agent reads or edits files matching the glob. The body is injected alongside the file contents. This is progressive disclosure — context loads on demand, not at session start.

Auto-activated skills enter the union-find forest as tagged messages, merging with the conversation cluster they're relevant to.

### Deactivation

Skills injected via slash command are active for the current turn only. Auto-activated skills persist in the forest like any other context — they're subject to the same compaction and eviction rules.

## Lifecycle

```
Consolidate extracts patterns from past sessions
    ↓
Consolidate generates candidate skills
    ↓
Human approves / rejects / edits candidates
    ↓
Remember.write_skill(skill) persists to disk
    ↓
Perceive discovers skill at next session start
    ↓
Filter loads skill when trigger matches
    ↓
Skill changes how the agent processes
```

Skills are created by Consolidate, stored by Remember, discovered by Perceive, and activated by Filter. The human approves at the creation step (Attend).

## Interface

```
Skill:
  name: string
  description: string
  trigger: 'slash' | 'auto' | 'both'
  allowed_tools: string[] | null
  paths: string[] | null
  model: string | null
  body: string

SkillStore (part of Remember):
  .write_skill(skill: Skill) → void
  .read_skills() → Skill[]
  .delete_skill(name: string) → void

SkillDiscovery (part of Perceive):
  .discover() → Skill[]
  .resolve_conflict(a: Skill, b: Skill) → Skill    # more specific scope wins

SkillActivation (part of Filter):
  .should_activate(skill: Skill, context: TurnContext) → boolean
  .inject(skill: Skill, context: TurnContext) → Content
```

## Convergence

Skills are the fixed-point operator for the harness. A well-written skill is idempotent — running it twice produces the same result. The "a bit" qualifier (from slop-detection) dampens a skill to convergence: the second pass finds almost nothing to change.

Skills that don't converge (oscillate between states on repeated application) are defective and should be flagged by Consolidate's quality check.

## Anti-patterns

- Skills that modify themselves (infinite recursion)
- Skills without descriptions (undiscoverable by the model)
- Auto-activated skills with no path restriction (fires on everything, wastes context)
- Skills that bypass the human approval step (unsupervised procedural memory writes)
- Skill descriptions longer than 250 characters (bloats the system prompt discovery list)
