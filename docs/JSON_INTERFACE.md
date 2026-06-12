# Loom — JSON Bulk-Ingestion Interface

This is a **public, stable contract** for loom's JSON bulk-ingestion commands.
External tools (orchestrators, CI pipelines, AI agents) may rely on the
schemas, stdout/stderr contracts, and exit codes defined here.
Changes that break existing callers must be communicated explicitly.

Two commands are covered:

| Command | Purpose |
|---|---|
| `loom apply <plan.json\|->` | Bulk item creation (epics, stories, tasks) |
| `loom dep apply <deps.json\|->` | Bulk dependency wiring |

Both commands:

- Accept a file path **or** `-` to read from **stdin**.
- Emit bare JSON on **stdout** (machine-readable; no trailing human text).
- Emit human-readable notes on **stderr**.
- Update `.loom/state.json` last-touched state after a successful apply.
- Never prompt interactively (no pickers; `-y` / `--non-interactive` is
  harmless but unnecessary).
- Round-trip cleanly through `loom rebuild` — deps and items are stored in
  markdown frontmatter (the source of truth), so rebuild is always a no-op
  after a successful apply.

The web/lib TypeScript mirror of these commands is **intentionally deferred**:
the Bun server has no bulk-create path today; notes are in `web/README.md`.

---

## `loom apply` — bulk item creation

### At a glance

```bash
loom apply plan.json            # from file
loom apply -                    # from stdin
loom apply --dry-run plan.json  # validate only; create nothing
```

### Input schema (nested)

Items form a tree: root items carry a `parent` qid pointing at an existing
store item; children are nested via a `children` list.  There is no
flat/forward-ref form — nesting *is* the parent relationship.

```json
{
  "items": [
    {
      "ref":      "e1",
      "type":     "epic",
      "parent":   "loom-app",
      "title":    "Auth overhaul",
      "body":     "## Summary\n…",
      "assignee": "8218f31b-…",
      "tags":     ["auth", "security"],
      "status":   "ready",
      "children": [
        {
          "ref":   "s1",
          "type":  "story",
          "title": "Login endpoint",
          "children": [
            {
              "type":   "task",
              "title":  "Failing test for login",
              "status": "blocked"
            }
          ]
        }
      ]
    }
  ]
}
```

### Field table

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `epic`, `story`, or `task`. `project` is not allowed — use `loom project create`. Cross-checked against the enclosing item type. |
| `parent` | string | **root items only**; forbidden on children | An existing qid in the store. A bare project qid as a story's parent targets its `backlog` epic. Refs are **not** valid parents — only existing qids. |
| `title` | string | yes | Non-empty human-readable title. |
| `ref` | string | no | Local handle, unique across the **whole plan tree**. Used only for the `created` ref→qid mapping in output. |
| `body` | string | no | Markdown body. Defaults to `""`. |
| `assignee` | string | no | Assignee string (free-form; typically a UUID or login). |
| `tags` | list[string] | no | Tag list. |
| `status` | string | no | Initial status. Defaults to `ready`. Any string is valid; only `done` has semantic effect on dependencies. |
| `children` | list | no | Nested child items. Allowed on `epic` and `story`; **forbidden on tasks** (tasks are leaves). |

### Validation (collect-all, before any write)

**All errors — structural and semantic — are collected in one combined pass.**
On failure, nothing is written and the complete error report is emitted on
stdout so you can fix every error in one editing pass, then re-apply.

Structural rules (field-level):
- `type` and `title` must be present on every item (absent field → `missing_field`).
- Unknown fields are rejected (`unknown_field`).
- `tags` and `children` must be JSON lists when present.

Semantic rules:
- `type` must be `epic`, `story`, or `task`.
- `title` must be non-empty string (present but empty/whitespace-only → `empty_title`).
- `ref` values must be unique across the **whole plan tree** (including nested children).
- `parent` on a root item must be an existing qid in the store. Refs, symbolic
  names, or symbolic references are not valid — always use existing qids.
- `parent` is **forbidden** on nested children (nesting is the relationship).
- Root items without a `parent` field are rejected.
- Type must be compatible with its enclosure:
  - `epic` → root only; parent must be a project.
  - `story` → inside an `epic`, or at root with project parent (targets `backlog`).
  - `task` → inside a `story`.
- `children` is forbidden on tasks.

### Validation error report

On any validation failure, stdout is a bare JSON error report; nothing is created.
Errors are reported in **document order** (pre-order walk position: e.g. `items[0]`
errors before `items[1]` errors, parent before children).

```json
{
  "errors": [
    {
      "path":    "items[0].children[1]",
      "code":    "bad_nesting",
      "message": "type 'epic' cannot be nested under 'story'; allowed children: ['task']"
    },
    {
      "path":    "items[1]",
      "code":    "unknown_parent",
      "message": "unknown parent qid 'no-such-proj'; must be an existing item qid in the store"
    }
  ]
}
```

Human-readable lines mirror the errors on **stderr**.

**Exit code** is determined by the **first error's** code (single-error case
preserves the previous exit-code specificity):

| First error code | Exit code |
|---|---|
| `unknown_parent` | 2 (`EXIT_NOT_FOUND`) |
| `duplicate_ref` | 3 (`EXIT_DUPLICATE`) |
| Everything else | 1 (`EXIT_GENERIC`) |
| Malformed JSON | 1 |

#### Stable error code constants

| Code | Meaning |
|---|---|
| `bad_type` | `type` value is not `epic`, `story`, or `task` |
| `empty_title` | `title` is present but empty or whitespace-only |
| `missing_field` | A required field (`type` or `title`) is absent from the item |
| `duplicate_ref` | A `ref` value appears more than once across the whole tree |
| `unknown_parent` | Root item's `parent` qid does not exist in the store |
| `missing_parent` | A root item has no `parent` field |
| `parent_on_child` | A nested child has a `parent` field (forbidden) |
| `children_on_task` | A task has a non-empty `children` list |
| `bad_nesting` | `type` is incompatible with the enclosing item type |
| `non_object` | An item in `items` or `children` is not a JSON object |
| `unknown_field` | An item contains an unrecognised field |

These constants are exported from `loom.bulk` (`CODE_*`) and are part of this
stable contract — code values will not change without a version bump.

#### Worked multi-error example

A plan with three independent errors produces a single report an agent can act
on without retrying:

**Input** (three errors at different depths):

```json
{
  "items": [
    {"type": "bogus",  "parent": "p",    "title": "X"},
    {"type": "epic",   "parent": "p",    "title": ""},
    {"type": "epic",   "parent": "nope", "title": "Y"}
  ]
}
```

**stdout** (one pass, all errors):

```json
{
  "errors": [
    {"path": "items[0]", "code": "bad_type",      "message": "invalid type 'bogus'; must be one of ['epic', 'story', 'task']"},
    {"path": "items[1]", "code": "empty_title",   "message": "title must be a non-empty string"},
    {"path": "items[2]", "code": "unknown_parent", "message": "unknown parent qid 'nope'; must be an existing item qid in the store"}
  ]
}
```

Fix all three in one editing pass, then re-apply.

### Stdout contract

On success, a single JSON object on stdout:

```json
{"created": [
  {"ref": "e1",   "qid": "loom-app:k3m9xwp",     "type": "epic"},
  {"ref": "s1",   "qid": "loom-app:k3m9xwp:1",   "type": "story"},
  {"ref": null,   "qid": "loom-app:k3m9xwp:1:1", "type": "task"}
]}
```

The `created` array is in **depth-first creation order** (parent before its
children; siblings in list order). `ref` is `null` for items with no `ref`.

### Stderr contract

Human-readable progress notes: `"created N item(s)"`. Do not parse stderr.

### `--dry-run`

Validates the plan and, on success, prints the would-be creation order as a
single JSON object on stdout (bodies omitted); creates nothing:

```json
{"plan": [
  {"ref": "e1", "type": "epic",  "parent": "loom-app", "title": "Auth overhaul"},
  {"ref": "s1", "type": "story", "title": "Login endpoint"},
  {"ref": null, "type": "task",  "title": "Failing test for login"}
]}
```

The `plan` array is in the same depth-first order as the would-be created list.

On an **invalid plan**, `--dry-run` prints the same `{"errors": [...]}` report
on stdout and exits nonzero — identical behavior to a normal failed run.

Exit 0 on valid plan, nonzero on validation failure.

### Partial failure / no rollback

Items are created depth-first. If creation fails mid-plan (a rare condition
given pre-validation), the partial `created` mapping is printed on stdout and
the process exits 1. **No rollback is performed** — "archive, not delete" is a
non-negotiable in loom's design. Callers should treat a nonzero exit + partial
stdout as a soft failure and inspect the store before re-running.

### Exit codes

| Code | Constant | Meaning |
|---|---|---|
| 0 | — | All items created |
| 1 | `EXIT_GENERIC` | Malformed JSON, bad schema, type/title/nesting error, mid-create failure |
| 2 | `EXIT_NOT_FOUND` | Unknown parent qid (`unknown_parent` is the first error) |
| 3 | `EXIT_DUPLICATE` | Duplicate `ref` value (`duplicate_ref` is the first error) |
| 5 | `EXIT_INVALID_ID` | Invalid qualified id format |

---

## `loom dep apply` — bulk dependency wiring

### At a glance

```bash
loom dep apply deps.json          # from file
loom dep apply -                  # from stdin
loom dep apply --dry-run deps.json  # validate only; apply nothing
```

### Input schema

```json
{"deps": [
  {"source": "loom-app:k3m9xwp:2", "on": "loom-app:k3m9xwp:1"},
  {"source": "loom-app:k3m9xwp:3", "on": "loom-app:k3m9xwp:1"}
]}
```

Direction matches `loom dep add <source> --on <target>`: the **source**
item waits for the **target** item (`source` depends on `on`).

All qids must be real, existing qualified ids — `loom dep apply` does not
resolve symbolic names or plan-local refs. Use `loom apply` first to
materialize items and capture their real qids from the output mapping, then
feed those qids to `loom dep apply`.

### Field table

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | yes | Qualified id of the item that will depend on `on`. Must not be a project. |
| `on` | string | yes | Qualified id of the item that `source` waits for. Must not be a project. |

### Validation rules (all-or-nothing, all checked before any write)

- Every `source` and `on` qid must exist in the store. Unknown qid → exit 2.
- Neither `source` nor `on` may be a project (projects have no status to
  satisfy). Violation → exit 1.
- No self-loops (`source == on`). Violation → exit 1.
- **One batch cycle check** over the existing dependency graph plus **all new
  edges together** — a cycle only visible when combining multiple new edges is
  detected regardless of edge order in the file. Cycle → exit 4; the offending
  cycle is printed on stderr. Nothing is applied.
- Already-existing edges are idempotent (counted in `added` as 0).

### Stdout contract

On success, a single JSON object on stdout:

```json
{"added": 2}
```

`added` is the number of **new** edges written. Edges that already existed
count as 0.

### Stderr contract

Per-edge notes: `"<source> -> <on>"` for each edge. Do not parse stderr.

### `--dry-run`

Validates all edges (same rules as above) and prints a human note to stderr;
applies nothing. Exit 0 on valid plan, nonzero on validation failure.

### Partial failure / no rollback

Because all validation runs before any write, partial failure is not
expected. If it occurs (e.g. a concurrent write), the process exits 1. The
store is left with whatever edges were written before the failure.

### Exit codes

| Code | Constant | Meaning |
|---|---|---|
| 0 | — | All edges applied (or already present) |
| 1 | `EXIT_GENERIC` | Malformed JSON, bad schema, self-loop, dep-on-project, mid-apply failure |
| 2 | `EXIT_NOT_FOUND` | Unknown source or target qid |
| 4 | `EXIT_CYCLE` | Batch cycle detected; nothing was applied |

---

## Typical orchestrator workflow

```bash
# Step 1: create items (nested plan)
result=$(loom apply plan.json)

# Step 2: extract qids from the mapping
epic_qid=$(echo "$result" | jq -r '.created[] | select(.ref=="e1") | .qid')
s1_qid=$(echo "$result"   | jq -r '.created[] | select(.ref=="s1") | .qid')
s2_qid=$(echo "$result"   | jq -r '.created[] | select(.ref=="s2") | .qid')

# Step 3: wire dependencies using real qids
loom dep apply - <<EOF
{"deps": [
  {"source": "$s2_qid", "on": "$s1_qid"}
]}
EOF

# Step 4: verify
loom validate
loom tree "$epic_qid"
```

stdin is accepted to avoid temp files in scripted pipelines.

If `loom apply` exits nonzero, stdout is `{"errors": [...]}` — fix all errors
in one editing pass before re-applying.

---

## Stability and versioning

This document tracks `schema_version: 3` (see `docs/MARKDOWN_SPEC.md`).
Non-breaking additions (new optional fields, new exit codes for new error
classes) do not require a version bump. Breaking changes (renamed fields,
removed keys, changed semantics) bump `schema_version` in
`docs/MARKDOWN_SPEC.md` and are announced here.
