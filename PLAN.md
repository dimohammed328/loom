# Loom — Design Plan

A markdown-based, hierarchy-agnostic project management system. Markdown
files are the source of truth; a SQLite index makes queries cheap.

---

## 1. Goals & non-goals

### Goals
- **Hierarchy:** project → epic → story → task, with cross-cutting
  dependencies that are *not* constrained by hierarchy (a story may depend
  on an epic, a project may depend on a task, etc.).
- **Markdown is the source of truth.** Every item is one `.md` file with
  YAML frontmatter for metadata and a free-form body. The directory tree
  is human-navigable and grep-able.
- **SQLite is a derived index.** It exists to make queries fast (`ready`,
  `find`, dependency walks). It must be rebuildable from the filesystem at
  any time with no data loss.
- **Three consumers, one API.** Humans (CLI), programs (Python library),
  and optionally agents all use the same primitives. No interface is
  privileged. The markdown schema is itself a public contract so custom
  UIs can be built on top.
- **Git-aware.** Projects carry repo / origin metadata; epics / stories /
  tasks can record the branch and PR URL associated with their work.

### Non-goals (v1)
- **Concurrency arbitration.** Loom does not police concurrent writers to
  the same item. See §7 — single-writer discipline is the caller's job.
- AI- or agent-specific behavior. The library is fully usable without any
  agent involvement; agents are just another consumer of the same API.
- Full-text search (FTS5) — defer.
- Watch-mode / auto-sync on filesystem change — defer.
- History / audit log inside loom — recommend `git init` in `$LOOM_DIR`.
- Web UI, TUI, graph visualization — out of scope (but the public API
  makes these straightforward to build).
- Multi-user permissions, encryption — out of scope.

---

## 2. Confirmed decisions

These were called out as ambiguous in earlier drafts and are now fixed.

1. Story IDs are sequential-numeric within an epic; tasks are
   sequential-numeric within a story. Both increment from 1 independently.
2. Epic IDs are unique within a project, not globally. The qualified ID
   disambiguates across projects.
3. No automatic done-propagation. Status changes are always explicit.
   `loom close <id> --if-children-done` is a convenience helper.
4. Statuses: three canonical values baked in (`ready`, `blocked`, `done`);
   users may add any custom statuses in `config.toml`. See §3.3.
5. Project-name regex `^[a-z][a-z0-9_-]{0,63}$`. Reserved: `projects`,
   `loom`, anything starting with `_`.
6. Cycle detection on dependency add: reject with the offending cycle.
7. v1 supports archive (move to `_archive/`); no hard delete from the
   CLI. `rm` + `loom rebuild` if you really mean it.
8. Depending on a project is forbidden; projects are containers, not
   work units.
9. Projects carry `repo` + `default_branch` (optional). Items carry
   `branch` + `pr_url` (optional, plain strings — loom does not track PR
   state).

---

## 3. Data model

### 3.1 Identifiers

| Level   | ID style                                    | Example         |
|---------|---------------------------------------------|-----------------|
| Project | user-assigned slug, validated               | `example_project` |
| Epic    | random 7-char string, Crockford-ish base32  | `apt2467`       |
| Story   | sequential int per epic, starting at 1      | `1`, `2`, `3`   |
| Task    | sequential int per story, starting at 1     | `1`, `2`, `3`   |

**Random alphabet for epics:** `abcdefghjkmnpqrstvwxyz23456789` (no
`0/o/O/1/i/I/l/u`) — 30 chars, ~34 bits at length 7. Collision
probability is negligible per project; on collision, regenerate.

**Qualified ID** is the canonical reference everywhere (frontmatter, DB,
CLI, API). Format: `project[:epic[:story[:task]]]`. Examples:
- Project: `example_project`
- Epic:    `example_project:apt2467`
- Story:   `example_project:apt2467:1`
- Task:    `example_project:apt2467:1:1`

### 3.2 Hierarchy + dependency model

- **Hierarchy** is purely structural. It does *not* imply dependency.
  Closing an epic does not auto-close its children; a task being done does
  not bubble up.
- **Dependencies** are a directed graph layered on top, edges being
  qualified IDs on either side. Any non-project item type may depend on
  any other non-project item type.
- **A dependency is satisfied iff `target.status == 'done'`.** `done` is
  the *only* status loom treats specially. Other statuses (canonical or
  custom) are advisory labels.
- **An item is *pickable* iff `status == 'ready'` AND every dependency is
  satisfied.** This is what `loom ready` returns. The status `ready` is
  the user's assertion that the work is ready to start; the dep-check
  layers on top.

### 3.3 Status

**Three canonical statuses are baked in and always available:**

| Status    | Meaning                                                     |
|-----------|-------------------------------------------------------------|
| `ready`   | Default for new items. Eligible to be picked up if deps allow. |
| `blocked` | Explicitly held; will not appear in `loom ready` regardless of deps. |
| `done`    | Terminal. Satisfies dependents.                              |

Only `done` has semantic effect on dependency satisfaction. `ready` is
load-bearing for the `loom ready` query. `blocked` is purely a convention
that excludes the item from `ready` results.

**Custom statuses are not registered anywhere — any string is a valid
status.** Loom only treats `done` specially (it satisfies dependencies)
and `ready` specially (it gates the `loom ready` query). Everything else,
canonical or custom, is a label loom doesn't interpret.

`loom statuses` enumerates every distinct status string currently in use
across the index — useful for discovering what conventions a project has
adopted.

If you want, e.g., `cancelled` to release dependents, close the item as
`done` with an explanatory body — `done` is the only resolving status.

Projects have no status field.

### 3.4 Done-propagation

No automatic propagation. Status changes are always explicit. The
`loom close <epic-id> --if-children-done` helper provides the convenient
case for closing parents when their subtree is complete.

---

## 4. Storage layout

`$LOOM_DIR` resolves to: `$LOOM_DIR` → `$XDG_DATA_HOME/loom` →
`~/.local/share/loom`.

```
$LOOM_DIR/
├── loom.db                          # SQLite index (derived; rebuildable)
├── .loom/                           # internal: tmp, anything non-content
└── projects/
    └── example_project/
        ├── project.md
        └── epics/
            └── apt2467/
                ├── epic.md
                └── stories/
                    └── 1/
                        ├── story.md
                        └── tasks/
                            ├── 1.md
                            └── 2.md
```

### 4.1 Path ↔ qualified-ID bijection (invariant)

The filesystem path uniquely encodes the qualified ID and vice versa:

- `projects/<P>/project.md`                                     ↔ `P`
- `projects/<P>/epics/<E>/epic.md`                              ↔ `P:E`
- `projects/<P>/epics/<E>/stories/<S>/story.md`                 ↔ `P:E:S`
- `projects/<P>/epics/<E>/stories/<S>/tasks/<T>.md`             ↔ `P:E:S:T`

This is a **hard invariant**: the rebuilder uses the path alone to derive
the qualified ID. If the frontmatter `id` disagrees with the path, the
path wins, and the file is rewritten with a warning. Any human can rename
a directory and `loom rebuild` will do the right thing.

### 4.2 Filename conventions

- Container items (project / epic / story) live in directories and have a
  type-named file (`project.md`, `epic.md`, `story.md`).
- Tasks are leaf files (`<n>.md`) directly in `tasks/`. v1 does not need
  per-task directories; if attachments are added later, tasks can grow
  into directories.

### 4.3 Archive

Archived items move to a parallel `_archive/` tree, preserving the
bijection:
```
$LOOM_DIR/_archive/projects/example_project/epics/apt2467/...
```

---

## 5. Markdown file specification

This is a **public contract.** Custom UIs and external tools may read and
write these files directly. The user-facing version of this section lives
at [`docs/MARKDOWN_SPEC.md`](docs/MARKDOWN_SPEC.md) — keep them in sync,
and prefer non-breaking additions; format changes that aren't backwards
compatible MUST bump `schema_version`.

### 5.1 Frontmatter (YAML)

Required for all items:
```yaml
---
schema_version: 1
id: apt2467                          # local id segment (not qualified)
qualified_id: example_project:apt2467
type: epic                           # project | epic | story | task
title: Add OAuth support
created_at: 2026-05-09T10:00:00Z
updated_at: 2026-05-09T10:00:00Z
---
```

Required for epic / story / task (not project):
```yaml
status: ready                        # ready | blocked | done | <custom>
                                     # default for new items: ready
```

Optional, on any non-project item:
```yaml
depends_on:
  - example_project:b8x934z
  - other_project:c2k856p:1:3
tags: [auth, security]
assignee: alice
branch: feat/oauth-google
pr_url: https://github.com/acme/example_project/pull/482
custom: { ... }                      # arbitrary user/tool extensions, preserved
```

Optional, on **projects only**:
```yaml
repo: https://github.com/acme/example_project
default_branch: main
```

Notes:
- `branch` / `pr_url` are plain strings. Loom does not validate or query
  GitHub. If you want PR state, look it up via `gh` or the GitHub API;
  loom is intentionally not a GitHub mirror.
- `repo` on a project is the upstream / origin URL. Items under the
  project inherit the project's `repo` for context; they don't need to
  repeat it.
- Unknown top-level frontmatter keys are **preserved** on read/write, so
  external tools can annotate items without loom stripping them.

### 5.2 Body

Free-form markdown after the closing `---`. No required structure.

### 5.3 schema_version

Present in every file. Currently `1`. Migrations bump this and run on
read.

---

## 6. SQLite schema

**Invariant:** the DB is derived. `loom rebuild` recreates it from the
filesystem with no data loss. Never store anything in the DB that isn't
also in markdown.

```sql
-- One row per item.
CREATE TABLE items (
  qualified_id     TEXT PRIMARY KEY,           -- "example_project:apt2467:1:1"
  type             TEXT NOT NULL CHECK (type IN ('project','epic','story','task')),
  project          TEXT NOT NULL,
  epic             TEXT,                       -- NULL for projects
  story            INTEGER,                    -- NULL for project/epic
  task             INTEGER,                    -- NULL for project/epic/story
  parent_id        TEXT,                       -- qualified_id of parent (NULL for project)
  title            TEXT NOT NULL,
  status           TEXT,                       -- NULL for projects; any string otherwise
  assignee         TEXT,
  branch           TEXT,
  pr_url           TEXT,
  repo             TEXT,                       -- projects only
  default_branch   TEXT,                       -- projects only
  archived         INTEGER NOT NULL DEFAULT 0, -- 0/1
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  file_path        TEXT NOT NULL UNIQUE,       -- path relative to $LOOM_DIR
  body_hash        TEXT NOT NULL,              -- sha256 of file contents; drift detection
  frontmatter_json TEXT NOT NULL               -- full frontmatter for round-trip / unknown keys
);

CREATE INDEX idx_items_status   ON items(status);
CREATE INDEX idx_items_type     ON items(type);
CREATE INDEX idx_items_parent   ON items(parent_id);
CREATE INDEX idx_items_project  ON items(project);
CREATE INDEX idx_items_assignee ON items(assignee);
CREATE INDEX idx_items_archived ON items(archived);

-- Dependency edges. source depends_on target.
CREATE TABLE dependencies (
  source_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
);
CREATE INDEX idx_dep_target ON dependencies(target_id);

-- Tags, many-to-many.
CREATE TABLE tags (
  item_id TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tag);
```

**Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
`busy_timeout=5000`. DB schema version tracked via `PRAGMA user_version`
(no separate metadata table needed).

**Drift detection:** every item row carries `body_hash`. On read, if the
on-disk file's hash differs from the indexed hash, loom re-syncs that
file into the index transparently. On write, loom warns if the on-disk
file changed since last index but proceeds.

**`loom rebuild`:** walks `projects/` and `_archive/`, parses every
`.md`, truncates and repopulates `items`, `dependencies`, `tags`. Reports
broken dependency targets, conflicting `id` vs path, frontmatter parse
errors. Idempotent.

---

## 7. Concurrency model

Loom is single-writer-per-item. **It does not arbitrate concurrent
writes.** Loom's contract:

- **Reads are always safe.** SQLite WAL mode + atomic file reads.
- **Writes to *different* items from different processes are safe.**
  SQLite handles row-level isolation; markdown writes are to disjoint
  files.
- **Writes to the *same* item from different processes may race.** Last
  writer wins on the markdown file; the index resyncs from disk. Loom
  does not lock, lease, or detect lost updates beyond the drift warning
  above.

This is sufficient for the expected uses: a single human at a terminal,
or an external orchestrator that already serializes work per item. If you
need stronger guarantees, layer them above loom.

---

## 8. Public Python API

The library lives at `loom`. All items share a common base; specialized
types expose only operations valid for their level.

```python
from loom import Loom
from loom.types import Status, ItemRef

loom = Loom()                                    # uses $LOOM_DIR
loom = Loom(root="/path/to/data")                # explicit override

# --- create -------------------------------------------------------------
project = loom.create_project(
    "example_project",
    title="Example",
    body="…",
    repo="https://github.com/acme/example_project",
    default_branch="main",
)
epic    = project.create_epic(title="Add OAuth", body="…")
story   = epic.create_story(title="Backend pieces", body="…")
task    = story.create_task(title="Add Google provider", body="…")
                                                 # all created with status='ready'

# --- lookup -------------------------------------------------------------
item = loom.get("example_project:apt2467:1:1")   # returns Task
items = loom.find(
    type="task", status="ready", assignee=None, tags=["auth"],
)

# --- mutate -------------------------------------------------------------
task.set_status("ready" | "blocked" | "done" | "<custom>")
task.complete()                                  # shortcut: status = 'done'
task.block()                                     # shortcut: status = 'blocked'
task.mark_ready()                                # shortcut: status = 'ready'

task.set_title("…")
task.set_body("…")
task.set_assignee("alice")
task.set_branch("feat/oauth-google")
task.set_pr_url("https://github.com/acme/example_project/pull/482")
task.set_frontmatter({"custom": {"score": 3}})   # merges, preserves unknowns
task.add_tag("urgent"); task.remove_tag("old")
task.archive()

project.set_repo("…"); project.set_default_branch("main")

# --- dependencies -------------------------------------------------------
task.depends_on("example_project:b8x934z:2")     # raises CycleError on cycle
task.remove_dependency("example_project:b8x934z:2")
task.dependencies()                              # list[ItemRef]; what it waits on
task.dependents()                                # list[ItemRef]; who waits on it
task.is_pickable()                               # status=='ready' AND deps satisfied
task.blockers()                                  # list[ItemRef] not-yet-done

# --- queries ------------------------------------------------------------
ready = loom.ready(type="task", limit=10)        # SQL-backed; pickable items
loom.close_if_children_done("example_project:apt2467")

# --- maintenance --------------------------------------------------------
loom.sync("example_project:apt2467:1:1")         # re-read one file into index
loom.rebuild()                                   # drop + repopulate index
loom.validate()                                  # report broken deps, drift, etc.
loom.statuses()                                  # canonical + every distinct status seen in index
```

`Status` is exposed as constants `Status.READY`, `Status.BLOCKED`,
`Status.DONE` for IDE convenience; setters accept any string — there is
no registration step, and no validation beyond "is it a string?"

### 8.1 Item types

- `Project` — `create_epic`, `epics()`, `archive`, `repo`, `default_branch`, no `status`.
- `Epic` — `create_story`, `stories()`, status, branch/PR, deps.
- `Story` — `create_task`, `tasks()`, status, branch/PR, deps.
- `Task` — leaf, status, branch/PR, deps.
- `ItemRef` — lightweight `{qualified_id, type, title, status}` for list
  returns without forcing a full file read.

All mutation methods are "write file, update index" in one call —
callers cannot get them out of sync.

### 8.2 Errors

`LoomError` (base), `NotFound`, `Duplicate`, `CycleError`, `Drift`,
`ValidationError`. All carry the offending qualified_id.

### 8.3 Design rules for the public API

- No leaking SQLite cursors or filesystem paths through the public
  surface. (They exist on `loom._storage` / `loom._index` for advanced
  consumers, but those are underscored.)
- Returned objects are detached snapshots. Mutating one does not
  magically update another in-memory copy; re-fetch with `.refresh()` if
  needed.

---

## 9. CLI surface

Built with `typer`. Noun-verb structure, qualified IDs as positional
args.

```
loom init                                          # init $LOOM_DIR + db
loom rebuild
loom validate
loom sync <qid>

# Items
loom project create <name> [--title …] [--repo …] [--default-branch …]
                            [--body … | --editor]
loom project list
loom epic    create <project>     [--title …] [--body … | --editor]
loom story   create <epic-qid>    [--title …] [--body … | --editor]
loom task    create <story-qid>   [--title …] [--body … | --editor]

loom show   <qid>                                  # frontmatter + body to stdout
loom edit   <qid>                                  # opens $EDITOR
loom update <qid> <field> <value>                  # title, status, assignee,
                                                   # branch, pr_url, repo, default_branch
loom tag    add|rm <qid> <tag>...
loom archive <qid>

# Status shortcuts (canonical statuses only — for customs use `update`)
loom complete    <qid>                             # status -> done
loom block       <qid>                             # status -> blocked
loom mark-ready  <qid>                             # status -> ready
loom close       <qid> --if-children-done          # close epic when subtree complete

# Dependencies
loom dep add  <qid> --on <qid>
loom dep rm   <qid> --on <qid>
loom dep list <qid> [--reverse]                    # blockers vs dependents

# Queries
loom list      [--type t] [--status s] [--tag t] [--assignee a] [--json]
loom ready     [--type t] [--tag t] [--limit n] [--json]
                                                   # status=='ready' AND deps satisfied
loom statuses                                      # distinct statuses currently in use
```

`--json` is available everywhere for programmatic consumption.

---

## 10. Implementation phases

Each phase ends with passing tests and a working CLI subset. No phase
depends on a later one.

### Phase 1 — Foundations
- Project bootstrapped with `uv` (`uv init`, src layout, `pyproject.toml`,
  `uv.lock` checked in). Dev deps via `uv add --dev pytest ruff` (ruff
  handles both lint and format). Tests run with `uv run pytest`.
- `.python-version` pinning the minimum supported interpreter.
- Path resolution: `$LOOM_DIR` → XDG → home default.
- `loom init` creates the directory + empty DB.
- Frontmatter parser using `ruamel.yaml` (preserves key order + unknown
  keys).
- Qualified-ID parser/formatter; path ↔ ID bijection helpers.
- Tests: round-trip parse/write preserving unknown keys; ID parsing edge
  cases; path conversions.

### Phase 2 — Storage + index
- File reader/writer.
- SQLite schema + `Index` class (apply, query, rebuild from FS).
- `loom rebuild`, `loom validate`, `loom sync` commands.
- Drift detection on read.
- `loom statuses` query (distinct status values from index).
- Tests: rebuild idempotency; drift handling; invalid-frontmatter
  recovery; status discovery.

### Phase 3 — Item CRUD
- `Project`, `Epic`, `Story`, `Task` classes with `create_*` chains.
- `get`, `find`, `set_*` (incl. branch, pr_url, repo, default_branch),
  status shortcuts (`complete`, `block`, `mark_ready`), `archive`.
- ID generation: random for epics with collision retry; sequential for
  story/task.
- CLI: `project|epic|story|task create`, `show`, `edit`, `set`, `tag`,
  `list`, `archive`, `complete`/`block`/`mark-ready`, `statuses`.
- Tests: create chains; sequential allocation; archive round-trip;
  branch/PR/repo round-trip; canonical & custom status round-trip.

### Phase 4 — Dependencies + ready
- `dependencies` table; add/remove with cycle detection (DFS on insert).
- `is_pickable`, `blockers`, `dependents`, `loom ready` query
  (status='ready' AND all deps done).
- `close_if_children_done` helper.
- CLI: `dep add|rm|list`, `ready`, `close --if-children-done`.
- Tests: cycle rejection; pickable computation across hierarchy levels;
  cross-project deps; close-if-done; custom statuses don't satisfy deps.

### Phase 5 — Polish
- `--json` everywhere; consistent error codes.
- README + `docs/MARKDOWN_SPEC.md` (the public file-format contract).
- API usage examples.

### Phase 5.5 — CLI ergonomics
- Interactive fallback when a required positional is missing AND
  `sys.stdin.isatty() and not --non-interactive`:
  - lookup-style inputs (parent / target qids) → `fzf`, falling back to a
    stdlib numbered picker; preselected from the workspace's last-touched
    state.
  - free-form inputs (title, body) → `$EDITOR` with a frontmatter
    template; for `update QID title`, opens the existing item file.
- Hard rename `loom set` → `loom update` (no alias; dev-mode).
- `loom project create` discovers `repo` from cwd's `origin` remote when
  `--repo` is omitted; fails if cwd is not a git repo with an origin.
- **Project-local workspace at `<git-toplevel>/.loom/state.json`** (or
  at cwd when the user is outside git). Created on `loom project create`;
  contains the bound project qid + most-recently-touched epic / story /
  task. Walk-up discovery from cwd (like `.git/`). Self-gitignored.
  Updated by any CLI mutation (create / update / archive / complete /
  block / mark-ready / close / dep add|rm / tag add|rm / edit); not by
  reads or by direct library API calls. Replaces the earlier draft that
  used `$XDG_STATE_HOME/loom/`.
- With a bound workspace, `loom epic create` skips the project picker
  entirely; story / task pickers preselect the last-touched parent.
- `loom project create` from inside an existing workspace silently
  re-binds and writes a one-line warning to stderr.
- Global `--non-interactive` / `-y` disables every prompt.

### Phase 6 (optional, post-v1)
- FTS5 search.
- File-watch auto-sync.
- Per-task directories with attachments.

---

## 11. Repo layout

```
loom/
├── pyproject.toml
├── uv.lock
├── .python-version
├── README.md
├── PLAN.md                 (this file)
├── docs/
│   └── MARKDOWN_SPEC.md    (the public file-format contract)
├── src/loom/
│   ├── __init__.py         (public API exports)
│   ├── api.py              (Loom facade)
│   ├── items.py            (Project/Epic/Story/Task)
│   ├── ids.py              (qualified-ID parse/format, generators)
│   ├── storage.py          (file I/O, frontmatter)
│   ├── index.py            (SQLite schema, queries, rebuild)
│   ├── deps.py             (cycle detection, pickable computation)
│   ├── status.py           (canonical Status constants + statuses() query)
│   ├── paths.py            ($LOOM_DIR resolution)
│   ├── errors.py
│   └── cli.py              (typer app)
└── tests/
    ├── test_ids.py
    ├── test_storage.py
    ├── test_index.py
    ├── test_items.py
    ├── test_deps.py
    ├── test_status.py
    └── test_cli.py
```
