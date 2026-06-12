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
loom apply plan.json          # from file
loom apply -                  # from stdin
loom apply --dry-run plan.json  # validate only; create nothing
```

### Input schema

```json
{
  "items": [
    {
      "ref":      "epic",
      "type":     "epic",
      "parent":   "loom-app",
      "title":    "Auth overhaul",
      "body":     "## Summary\n…",
      "assignee": "8218f31b-…",
      "tags":     ["auth", "security"],
      "status":   "ready"
    },
    {
      "ref":    "s1",
      "type":   "story",
      "parent": "epic",
      "title":  "Login endpoint"
    },
    {
      "type":   "task",
      "parent": "s1",
      "title":  "Failing test for login",
      "status": "blocked"
    }
  ]
}
```

### Field table

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `epic`, `story`, or `task`. `project` is not allowed here — use `loom project create`. |
| `parent` | string | yes | A `ref` defined **earlier** in the same list (no forward refs), or an existing qualified id. A bare project qid as a story's parent targets its `backlog` epic. |
| `title` | string | yes | Non-empty human-readable title. |
| `ref` | string | no | Local handle, unique within the file. Required when other items use this item as `parent` or when you need the mapping in output. |
| `body` | string | no | Markdown body. Defaults to `""`. |
| `assignee` | string | no | Assignee string (free-form; typically a UUID or login). |
| `tags` | list[string] | no | Tag list. |
| `status` | string | no | Initial status. Defaults to `ready`. Any string is valid; only `done` has semantic effect on dependencies. |

### Validation rules (all checked before any write)

- `type` must be `epic`, `story`, or `task`.
- `title` must be non-empty.
- `ref` values must be unique within the file.
- `parent` must resolve to an already-seen `ref` or an existing qid.
  Forward references (a later item's `ref`) are **not** allowed.
- Type/parent compatibility:
  - `epic` → parent must be a project.
  - `story` → parent must be an epic or a project (auto-targets `backlog`).
  - `task` → parent must be a story.
- Unknown parent qid → exit 2 (`EXIT_NOT_FOUND`).
- Duplicate `ref` → exit 3 (`EXIT_DUPLICATE`).
- Bad type, incompatible parent, empty title → exit 1 (`EXIT_GENERIC`).
- Malformed JSON → exit 1.
- Missing `items` key → exit 1.

### Stdout contract

On success, a single JSON object on stdout:

```json
{"created": [
  {"ref": "epic", "qid": "loom-app:k3m9xwp",   "type": "epic"},
  {"ref": "s1",   "qid": "loom-app:k3m9xwp:1", "type": "story"},
  {"ref": null,   "qid": "loom-app:k3m9xwp:1:1", "type": "task"}
]}
```

The `created` array is in the same order as the input `items` list.
`ref` is `null` for items with no `ref` in the input.

### Stderr contract

Human-readable progress notes: `"created N item(s)"`. Do not parse stderr.

### `--dry-run`

Validates the plan and prints the would-be plan as a single JSON object on
stdout (bodies omitted); creates nothing. A human note goes to stderr.
Exit 0 on valid plan, nonzero on validation failure.

```json
{"plan": [
  {"ref": "epic", "type": "epic", "parent": "loom-app", "title": "Auth overhaul"}
]}
```

The `plan` array is in input order; `parent` is echoed as given (a local
`ref` stays a `ref`, a qid stays a qid).

### Partial failure / no rollback

Items are created in file order. If creation fails mid-plan (a rare
condition given pre-validation), the partial `created` mapping is printed
on stdout and the process exits 1. **No rollback is performed** — "archive,
not delete" is a non-negotiable in loom's design. Callers should treat a
nonzero exit + partial stdout as a soft failure and inspect the store before
re-running.

### Exit codes

| Code | Constant | Meaning |
|---|---|---|
| 0 | — | All items created |
| 1 | `EXIT_GENERIC` | Malformed JSON, bad schema, type/title error, mid-create failure |
| 2 | `EXIT_NOT_FOUND` | Unknown parent qid |
| 3 | `EXIT_DUPLICATE` | Duplicate `ref` value |
| 5 | `EXIT_INVALID_ID` | Invalid qualified id format |

---

## `loom dep apply` — bulk dependency wiring

### At a glance

```bash
loom dep apply deps.json      # from file
loom dep apply -              # from stdin
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
resolve forward references or symbolic names. Use `loom apply` first to
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
# Step 1: create items
result=$(loom apply plan.json)

# Step 2: extract qids from the mapping
epic_qid=$(echo "$result" | jq -r '.created[] | select(.ref=="epic") | .qid')
s1_qid=$(echo "$result" | jq -r '.created[] | select(.ref=="s1") | .qid')
s2_qid=$(echo "$result" | jq -r '.created[] | select(.ref=="s2") | .qid')

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

---

## Stability and versioning

This document tracks `schema_version: 3` (see `docs/MARKDOWN_SPEC.md`).
Non-breaking additions (new optional fields, new exit codes for new error
classes) do not require a version bump. Breaking changes (renamed fields,
removed keys, changed semantics) bump `schema_version` in
`docs/MARKDOWN_SPEC.md` and are announced here.
