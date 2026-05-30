# loom plugin for Claude Code

A Claude Code plugin that integrates [loom](https://github.com/danish/loom) — a markdown-based,
hierarchy-agnostic project management CLI — into your AI-assisted development workflow.

## What this plugin provides

- **Lifecycle hooks** — SubagentStart injects loom workflow context; SubagentStop/Task/PostToolUse events are logged.
- **Skills** — `/brainstorming`, `/epic`, `/story`, `/executing-plans`, `/writing-plans`, and more.
- **Agents** — Specialized subagents for epic orchestration, story execution, integration, and validation.

## Installation

### Via marketplace (recommended)

If you have a marketplace configured that lists this plugin:

```
/plugin marketplace add ~/tech/loom
/plugin install loom@<marketplace>
```

Replace `<marketplace>` with the marketplace name configured for your Claude Code instance
(e.g. `loom` if you used `~/tech/loom` as the marketplace root).

### Direct install

```
/plugin install ./plugin
```

Run this from the root of the loom repository.

## Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `loom:brainstorming` | `/brainstorming` | Groom a feature into a loom epic or story |
| `loom:epic` | `/epic <description>` | Full epic: plan → parallel execution → PR |
| `loom:story` | `/story <description>` | Single story: plan → execute → validate → PR |
| `loom:executing-plans` | (internal) | Orchestrate story executors after plans are written |
| `loom:writing-plans` | (internal) | Materialize groomed drafts as loom items |
| `loom:using-loom-cli` | (internal) | Reference for correct loom CLI flags |
| `loom:verification-before-completion` | (internal) | Require evidence before claiming work complete |
| `loom:test-driven-development` | (internal) | TDD discipline for story executors |

## Agents

| Agent | Role |
|-------|------|
| `codebase-researcher` | Read-only research during groom phase |
| `epic-validator` | Validate epic-level criteria after merge |
| `story-executor` | Implement a single story on an isolated branch |
| `story-integrator` | Merge a story branch and run post-merge validation |

## Namespace

All skills are registered under the `loom:` prefix. Example: `loom:brainstorming`.

## Requirements

- Claude Code with plugin support
- `loom` CLI installed and on `$PATH` (`uv run loom` or `pip install loom-pm`)
- A loom workspace initialised in your project (`loom init` or `loom project create`)

## License

MIT
