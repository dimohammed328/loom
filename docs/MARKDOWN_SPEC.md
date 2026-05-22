# Loom — Markdown File Format

This is the **public, stable contract** for loom's on-disk format.
External tools may read and write loom files directly. Loom's internal
implementation may evolve, but this format will not change in
backwards-incompatible ways without bumping `schema_version`.

## At a glance

Every loom item is one Markdown file with YAML frontmatter:

```markdown
---
schema_version: 2
id: apt2467
qualified_id: example_project:apt2467
type: epic
title: Add OAuth support
status: ready
created_at: 2026-05-09T10:00:00+00:00
updated_at: 2026-05-09T10:00:00+00:00
tags: [auth, security]
---

## Context

Free-form markdown body goes here.
```

## Directory layout (the path ↔ qualified-id bijection)

The path encodes the qualified id and vice versa. Loom uses the path —
not the frontmatter — as the source of truth for identity. If they
disagree, the path wins and `loom rebuild` rewrites the frontmatter.

```
$LOOM_DIR/
├── loom.db                          # derived SQLite index
└── projects/
    └── <project>/
        ├── project.md                                                ↔ <project>
        └── epics/
            └── <epic>/
                ├── epic.md                                           ↔ <project>:<epic>
                └── stories/
                    └── <story>/
                        ├── story.md                                  ↔ <project>:<epic>:<story>
                        └── tasks/
                            └── <task>.md                             ↔ <project>:<epic>:<story>:<task>
```

Archived items move to a parallel `_archive/` tree, preserving the
bijection:

```
$LOOM_DIR/_archive/projects/<project>/epics/<epic>/...
```

## Identifier rules

| Level   | Format                                              | Example         |
|---------|-----------------------------------------------------|-----------------|
| Project | `^[a-z][a-z0-9_-]{0,63}$`, not in `{projects, loom, _archive}`, no leading `_` | `acme-v2` |
| Epic    | exactly 7 chars from `abcdefghjkmnpqrstvwxyz23456789` (Crockford-ish, no `0/1/i/l/o/u`), **or** the literal `backlog` | `apt2467`, `backlog` |
| Story   | positive decimal int (no leading zeros)             | `1`, `2`, `42`  |
| Task    | positive decimal int (no leading zeros)             | `1`, `2`, `42`  |

A **qualified id** joins the segments with `:`. Examples:

- `acme_v2`
- `acme_v2:apt2467`
- `acme_v2:apt2467:1`
- `acme_v2:apt2467:1:1`

Story and task ids are sequential per parent, starting at 1. They are
allocated by scanning both live and archived siblings, so an archived
sibling's id is never reused.

### The `backlog` epic

Every project is created with a default `backlog` epic at
`projects/<project>/epics/backlog/epic.md`. It is loom's canonical
home for one-off work that doesn't warrant a dedicated epic — bug
fixes, small patches, ad-hoc tasks. Tools may treat `backlog` as a
known, addressable target; loom itself only special-cases it in two
places:

1. `Loom.create_project` writes the backlog epic alongside the
   project file.
2. The CLI's `loom story create <project>` (a bare project qid)
   defaults to creating the story under `<project>:backlog`.

The backlog epic is otherwise a normal epic — same frontmatter,
same status semantics, same dependency rules.

## Frontmatter — required fields

These keys are required on **every** item:

| Key | Type | Notes |
|-----|------|-------|
| `schema_version` | int | Currently `2`. |
| `id` | string | The local id segment (not the qualified id). |
| `qualified_id` | string | The full colon-joined path. Must match the file path. |
| `type` | string | One of `project`, `epic`, `story`, `task`. |
| `title` | string | Required, non-empty. |
| `created_at` | string | ISO-8601 UTC timestamp (e.g. `2026-05-09T10:00:00+00:00`). |
| `updated_at` | string | ISO-8601 UTC timestamp. |

These keys are required on `epic`, `story`, and `task` (not on
`project`):

| Key | Type | Notes |
|-----|------|-------|
| `status` | string | Default for new items: `ready`. See "Status semantics" below. |

## Frontmatter — optional fields

On any **non-project** item:

| Key | Type | Notes |
|-----|------|-------|
| `depends_on` | list of qualified ids | This item is blocked until each target is `done`. Targets must be non-project items; depending on a project is forbidden. |
| `tags` | list of strings | Free-form labels. |
| `assignee` | string | Free-form. Loom does not validate users. |
| `branch` | string | Free-form git branch name. Loom does not interact with git. |
| `pr_url` | string | Free-form URL. Loom does not look up PR state. |

On **projects only**:

| Key | Type | Notes |
|-----|------|-------|
| `repo` | string | Upstream / origin URL. |
| `default_branch` | string | Default git branch for the project. |

**Unknown frontmatter keys are preserved on round-trip.** External
tools may add their own annotations without loom stripping them.

## Status semantics

Three canonical statuses are baked in:

| Status | Meaning |
|--------|---------|
| `ready` | Default for new items. Eligible to be picked up if every dep is `done`. |
| `blocked` | Explicitly held. Excluded from `loom ready` regardless of deps. |
| `done` | Terminal. Satisfies dependents. |

**Custom statuses are not registered anywhere — any string is a valid
status.** Loom only treats `done` specially (it satisfies dependencies)
and `ready` specially (it gates the `loom ready` query). Everything
else, canonical or custom, is a label loom doesn't interpret.

`loom statuses` enumerates every distinct status string currently in
use across the index — useful for discovering conventions a project
has adopted.

Projects do not have a status field.

## Body

Everything after the closing `---` is free-form markdown. Loom never
parses or rewrites the body; it only reads it for the file's `body_hash`
(used to detect drift between disk and the SQLite index).

A body containing horizontal rules (`---` lines) is fine — only the
**first** `---` after the opening fence is treated as the closing
fence.

## File-write semantics

When loom (or your tool) writes an item file:

- The file is written atomically: a sibling temp file is created and
  renamed into place, so a Ctrl-C mid-write cannot leave a partial
  file.
- Files end with exactly one trailing newline.
- Frontmatter key order is preserved (loom uses `ruamel.yaml` round-trip
  mode; external tools should follow suit if they want diff-friendly
  edits).

## Drift, validation, and rebuild

Any change made to a file outside loom (`vim`, `git checkout`, your own
script) is detected the next time loom reads the file: the on-disk
sha256 differs from the indexed `body_hash`, and `loom validate`
surfaces a `drift` issue. Run `loom sync <qid>` to re-read one item, or
`loom rebuild` to regenerate the entire index from the filesystem.

The DB at `$LOOM_DIR/loom.db` is **derived**. It must always be
reproducible from the markdown tree alone. Never store anything in the
DB that isn't also in markdown.

## Versioning

`schema_version: 2` is the current version (v1 differed only by
disallowing the literal `backlog` epic id). A future
incompatible change will bump this and ship a migration. Tools that
write loom files MUST set `schema_version` to the version they
understand; loom rejects unknown versions explicitly rather than
guessing.
