# plugin/CLAUDE.md

Guidance for working inside the `plugin/` directory of the loom repository.
This file governs the plugin artefacts only. The repo-root `CLAUDE.md` governs
the loom Python project and takes precedence for everything outside `plugin/`.

## What lives here

```
plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (name, description, hooks)
├── agents/                  # Subagent definition files (*.md)
├── hooks/
│   └── hooks.json           # Hook wiring (legacy; plugin.json is authoritative)
├── scripts/                 # Shell helpers invoked by hooks
├── skills/                  # Skill directories, each with a SKILL.md
│   └── writing-workflows/   # Generates baked-DAG workflow scripts at plan time
│       ├── SKILL.md         # Skill definition: generation procedure + invariants
│       ├── templates/       # Source templates (epic-runner, story-runner)
│       └── examples/        # Example generated workflows (for reference/testing)
├── README.md                # End-user install and usage guide
└── CLAUDE.md                # This file
```

Workflow scripts are **generated** by `loom:writing-workflows` into `.loom/workflows/`
(gitignored) at plan time — there is no static `plugin/workflows/` directory.
The `plugin/skills/writing-workflows/templates/` directory holds the source
templates; `examples/` holds concrete filled instances for reference and `node --check`.

## Namespace

All skills in this plugin are registered under the **`loom:` prefix**.
When referencing a skill from within a SKILL.md or agent prompt, use the
fully-qualified name: `loom:<skill-name>`. Examples:

- `loom:brainstorming`
- `loom:epic`
- `loom:story`
- `loom:using-loom-cli`

Do not use bare names (e.g. `brainstorming`) inside plugin artefacts — they
are ambiguous when other plugins are installed.

## Skill file conventions

Every skill lives in `plugin/skills/<skill-name>/SKILL.md`.

Required frontmatter fields:

```yaml
---
name: <skill-name>          # matches the directory name exactly
description: "<one sentence describing when to trigger this skill>"
---
```

- `name` must match the containing directory name.
- `description` is shown to the model as the trigger condition; keep it
  concise and action-oriented.
- Do not add `namespace:`, `prefix:`, or any undocumented field — the
  plugin loader ignores them and they add noise.

## Agent file conventions

Every agent lives in `plugin/agents/<agent-name>.md`.

Required frontmatter fields:

```yaml
---
name: <agent-name>
description: "<one sentence describing the agent's role>"
---
```

Optional fields: `tools`, `model`, `effort`.

- Use `model: fable` with `effort: xhigh` for agents that do heavy reasoning (e.g. orchestrators, validators). Use `model: sonnet` with `effort: medium` for mechanical agents.
- List only the tools the agent actually needs under `tools:`.

## Hook scripts

Scripts under `plugin/scripts/` are invoked by the hooks defined in
`plugin/.claude-plugin/plugin.json`. They must be POSIX-compatible shell
scripts or executables. Do not introduce Node.js or Python dependencies here —
keep hooks lightweight.

## What NOT to put here

- Reference skills only via the authoritative `loom:` namespace; do not use
  bare names or other plugins' skill namespaces. This plugin is self-contained.
- Do not add references to third-party AI coding platforms or their upstream
  repositories. This plugin is self-contained and Claude Code only.
- Do not add `config.toml`, lock files, or any artefact that duplicates
  information already in `plugin.json` or the repo-root `pyproject.toml`.
- Do not add pytest files or Python test infrastructure — tests for loom
  proper live under the repo-root `tests/`.

## Editing this plugin

1. Skills: edit `plugin/skills/<name>/SKILL.md`. Keep frontmatter valid.
2. Agents: edit `plugin/agents/<name>.md`. Keep frontmatter valid.
3. Hooks: edit `plugin/.claude-plugin/plugin.json`. Validate JSON before committing.
4. Scripts: keep POSIX-compatible; no external runtime deps.
5. README: keep the install instructions (`/plugin marketplace add` +
   `/plugin install loom@<marketplace>`) accurate.

After any change, verify:

```bash
python3 -c "import json; json.load(open('plugin/.claude-plugin/plugin.json'))"
```
