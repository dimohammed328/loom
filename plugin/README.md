# loom plugin for Claude Code

A Claude Code plugin that integrates [loom](https://github.com/danish/loom) — a markdown-based,
hierarchy-agnostic project management CLI — into your AI-assisted development workflow.

## What this plugin provides

- **`/epic` and `/story` workflows** — plan work in conversation, record it as loom
  epics/stories/tasks, execute via `story-executor` subagents (parallel where the
  dependency graph allows), validate, and finalize with a PR.
- **Discipline skills** — TDD, systematic debugging, verification-before-completion,
  code-review etiquette — injected at session start via `using-loom-skills`.

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
| `loom:epic` | `/epic <description>` | Multi-story change: groom → loom epic → parallel executors → validate → PR |
| `loom:story` | `/story <description>` | Single scoped change: groom → loom story → one executor → validate → PR |
| `loom:using-loom-skills` | session start | Establishes skill-invocation discipline |
| `loom:test-driven-development` | (internal) | TDD discipline for story executors |
| `loom:verification-before-completion` | (internal) | Evidence before claiming work complete |
| `loom:systematic-debugging` | (internal) | Root-cause discipline for bugs and test failures |
| `loom:requesting-code-review` / `loom:receiving-code-review` | (internal) | Review etiquette |
| `loom:writing-skills` | (internal) | TDD-for-documentation when editing plugin skills |

## Agents

| Agent | Role |
|-------|------|
| `story-executor` | Implement a single loom story in its own worktree, one commit per task |

## Namespace

All skills are registered under the `loom:` prefix. Example: `loom:epic`.

## Requirements

- Claude Code with plugin support
- `loom` CLI installed and on `$PATH` (`uv run loom` or `pip install loom-pm`)
- A loom workspace initialised in your project (`loom init` or `loom project create`)
- `gh` CLI for PR finalization

## License

MIT
