# loom plugin for Claude Code

A Claude Code plugin that integrates [loom](https://github.com/danish/loom) — a markdown-based,
hierarchy-agnostic project management CLI — into your AI-assisted development workflow.

## What this plugin provides

- **Lifecycle hooks** — SubagentStart injects loom workflow context; SubagentStop and Bash git-operation events are logged.
- **Skills** — `/brainstorming`, `/epic`, `/story`, `/writing-plans`, and more.
- **Agents** — Specialized subagents for story execution and validation.

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
| `loom:writing-plans` | (internal) | Materialize groomed drafts as loom items; hands off to `loom:writing-workflows` |
| `loom:writing-workflows` | (internal) | Generate bespoke baked-DAG workflow script and launch it |
| `loom:using-loom-cli` | (internal) | Reference for correct loom CLI flags |
| `loom:verification-before-completion` | (internal) | Require evidence before claiming work complete |
| `loom:test-driven-development` | (internal) | TDD discipline for story executors |

## Agents

| Agent | Role |
|-------|------|
| `codebase-researcher` | Read-only research during groom phase |
| `epic-validator` | Validate epic-level criteria after all stories merge |
| `story-executor` | Implement a single story on an isolated branch |

## Namespace

All skills are registered under the `loom:` prefix. Example: `loom:brainstorming`.

## Requirements

- Claude Code with plugin support
- `loom` CLI installed and on `$PATH` (`uv run loom` or `pip install loom-pm`)
- A loom workspace initialised in your project (`loom init` or `loom project create`)

## License

MIT
