# CLAUDE.md

Guidance for Claude (and humans) working in this repo. This file is the
single source of truth for repo-level conventions. Decisions recorded
here are not re-litigatable without explicit user approval.

## Commands

`uv`-managed Python 3.11 project.

| Task | Command |
|---|---|
| Install / sync deps | `uv sync` |
| Run all tests | `uv run pytest` |
| Run one test file | `uv run pytest tests/test_index.py` |
| Run one test | `uv run pytest tests/test_rebuild.py::test_sync_one_reflects_disk_edits` |
| Lint (auto-fixable) | `uv run ruff check --fix src tests` |
| Format | `uv run ruff format src tests` |
| Run the CLI | `uv run loom <command>` (e.g. `LOOM_DIR=/tmp/x uv run loom init`) |
| Add a runtime dep | `uv add <pkg>` |
| Add a dev dep | `uv add --group dev <pkg>` |

Tests, lint, and format must all pass before declaring work complete.

## What loom is

A markdown-based, hierarchy-agnostic project management library + CLI:
projects → epics → stories → tasks, with cross-cutting dependencies
that are *not* constrained by hierarchy (a story may depend on an epic,
a project may depend on a task, etc.). Three intended consumers: humans
(CLI), programs (Python library), and AI agents — none privileged. The
markdown schema is itself a public contract (`docs/MARKDOWN_SPEC.md`)
so custom UIs can be built on top.

## Architecture: two load-bearing invariants

**1. Markdown is the source of truth; SQLite is a derived index.**
Everything in `loom.db` must also be in some `.md` file under
`$LOOM_DIR/projects/` (or `$LOOM_DIR/_archive/projects/`). `loom rebuild`
regenerates the DB from the filesystem with no data loss; this works
because no information lives only in the DB.

**2. The filesystem path encodes the qualified id (and vice versa).**
`projects/<P>/epics/<E>/stories/<S>/tasks/<T>.md` ↔ `P:E:S:T`. The
rebuilder uses the path alone to derive the qid; if frontmatter
disagrees, **path wins** and the file is rewritten with a logged
warning. See `ids.qid_from_path` / `ids.path_from_qid`.

Together these mean: a human can rename a directory or hand-edit a file
and `loom rebuild` will reconcile. They also mean any code that reads
the DB must be prepared for the rebuild contract — never persist
DB-only state.

## Non-negotiables

These decisions are settled; changing one requires explicit user approval.

1. **Story / task ids are sequential-numeric within their parent**, both
   increment from 1 independently.
2. **Epic ids are unique within a project**, not globally; the qualified
   ID disambiguates across projects. They are 7 chars from
   `abcdefghjkmnpqrstvwxyz23456789` (Crockford-ish, no `0/1/i/l/o/u`),
   **or** the literal `backlog` (the auto-created default epic on
   every project — see `docs/MARKDOWN_SPEC.md`).
3. **Project-name regex** `^[a-z][a-z0-9_-]{0,63}$`. Reserved names:
   `projects`, `loom`, anything starting with `_`.
4. **No automatic done-propagation.** Status changes are always
   explicit. `loom close <id> --if-children-done` is a convenience
   helper, not a side effect of any other operation.
5. **Statuses:** `ready`, `blocked`, `done` are baked-in canonical
   values. Any other string is a valid custom status. **Only `done`
   has semantic effect** (satisfying dependencies). `ready` is the
   default for new items and gates `loom ready`. There is no
   registration step.
6. **Cycle detection on dependency add** — reject with the offending
   cycle.
7. **Archive, not delete.** Archived items move to a parallel
   `_archive/` tree preserving the path-qid bijection. No hard delete
   from the CLI; `rm` + `loom rebuild` if you really mean it.
8. **Depending on a project is forbidden.** Projects are containers,
   not work units.
9. **Projects carry `repo` + `default_branch`** (optional). Items carry
   `branch` + `pr_url` (optional, plain strings — loom does not track
   PR state).
10. **No `config.toml`.** Don't add one without explicit user approval.
11. **Concurrency:** loom does NOT arbitrate concurrent writes to the
    same item. Single-writer-per-item is the caller's responsibility.
    Don't add locks, leases, or claim protocols.
12. **Dev mode — no backwards-compat shims.** No external users yet;
    when changing names, signatures, or schema, change them cleanly and
    delete the old code. See `~/.claude/projects/-Users-danish-tech-loom/
    memory/project_dev_mode.md` if memory is active.

## Storage layout

`$LOOM_DIR` resolves as: `$LOOM_DIR` → `$XDG_DATA_HOME/loom` →
`~/.local/share/loom`.

```
$LOOM_DIR/
├── loom.db                         # SQLite index (derived; rebuildable)
├── .loom/                          # internal: tmp, non-content
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

Container items (project / epic / story) live in directories with a
type-named file. Tasks are leaf files (`<n>.md`) under `tasks/`. If
attachments are ever added, tasks can grow into directories without
breaking the bijection.

Archived items move to a parallel tree preserving the bijection:
`$LOOM_DIR/_archive/projects/<P>/epics/<E>/…`.

### Project-local workspace (`.loom/`)

Separate from `$LOOM_DIR`, the CLI maintains a per-project workspace at
`<git-toplevel>/.loom/` (or cwd, when `--repo` was used outside git).
Created by `loom project create`. Contains:

- `state.json` — bound loom project qid + last-touched epic / story /
  task. Schema: `{schema_version, project, last: {epic, story, task}}`.
- `.gitignore` containing `*` so the workspace stays out of the user's
  git index.

Discovered by walk-up from cwd, like `.git/`. **Updated by any CLI
mutation** (create / update / archive / complete / block / mark-ready /
close / dep add|rm / tag add|rm / edit); **not** updated by reads or
by direct library API calls. See `src/loom/state.py`.

## Module map

```
paths.py        $LOOM_DIR resolution: $LOOM_DIR → $XDG_DATA_HOME/loom → ~/.local/share/loom
errors.py       LoomError hierarchy. Add new concrete errors here, not inline.
ids.py          QualifiedId dataclass, parse_qid, random_epic_id, path↔qid bijection
storage.py      Atomic markdown read/write with order-preserving YAML frontmatter
index.py        SQLite schema + Index class (apply_record, get, find, replace_all, statuses)
scan.py         walk_md_files, hash_file_bytes, build_record (FS → IndexRecord)
validation.py   ValidationIssue + validate(); reads deps from frontmatter (the source of truth)
rebuild.py      rebuild() and sync_one(); orchestrates scan + Index
bootstrap.py    init() — `mkdir -p`-shaped: idempotent, never destructive
items.py        Project/Epic/Story/Task. Mutators read → mutate → atomic write → re-index → update self
deps.py         ItemRef, blockers/dependencies/dependents, cycle check, add/remove_dependency, descendants
api.py          Loom facade: create_project, get, find, projects, sync, rebuild, validate, statuses, ready, close_if_children_done

# CLI ergonomics (CLI-only; library API doesn't depend on these)
state.py        .loom/ workspace state: find/load/init/update_workspace, defaults_for
prompts.py      Interactive picker (fzf + numbered fallback) and $EDITOR helpers
gitprobe.py     Subprocess wrappers: is_git_repo, discover_remote, git_toplevel
cli.py          typer app; each subcommand is a thin wrapper over the library
```

v1 is complete. Potential future work (intentionally deferred): FTS5
search, file-watch auto-sync, per-task attachment directories.

## CLI ergonomics

When a required positional is missing AND `sys.stdin.isatty() and not
--non-interactive`:

- **Lookup-style inputs** (parent qid, item qid, target qid) launch
  `fzf`; if `fzf` isn't on `$PATH`, a stdlib numbered picker is used.
  Preselection comes from the workspace's last-touched state.
- **Free-form inputs** (title, body) open `$EDITOR` on a temp file with
  a frontmatter template. For `update QID title`, the existing item
  file is opened instead.

`loom project create` auto-discovers the repo URL from cwd's `origin`
remote when `--repo` is omitted; it fails outside a git repo with an
origin. On success, it anchors a `.loom/` workspace at the git
toplevel. Re-running `project create` in an existing workspace silently
re-binds and writes a one-line warning to stderr.

With a bound workspace, `loom epic create` consumes the workspace's
`project` directly and skips the project picker. `story create` and
`task create` still run pickers (since one project has many epics) but
preselect the last-touched parent.

Global `--non-interactive` / `-y` disables every prompt. **CliRunner is
non-TTY**, which is why all existing tests pass unchanged — the TTY
guard at `prompts.is_interactive` is the load-bearing invariant.

## CLI exit-code contract

Stable for scripts; see `cli.py`.

```
EXIT_GENERIC      = 1
EXIT_NOT_FOUND    = 2
EXIT_DUPLICATE    = 3
EXIT_CYCLE        = 4
EXIT_INVALID_ID   = 5
```

`--json` is supported on every read-side CLI command (`list`, `ready`,
`statuses`, `validate`, `dep list`, `show`, `project list`, `rebuild`).

## The mutator contract

Every `set_*` / `add_tag` / `complete` / `archive` on an `Item` follows
the same five steps in `items.py`: read file → mutate frontmatter →
atomic dump → rebuild `IndexRecord` → assign to `self._record`. The
last step matters: returned items are *detached snapshots*; mutating
one doesn't update another in-memory copy. After
`task.set_title("x")`, the same `task` reads `"x"` immediately; a
sibling `task2 = loom.get(qid)` taken earlier won't until
`.refresh()`.

## Specific gotchas

### Sequential ID allocation scans archive too

`_next_sequential_id` in `items.py` scans **both** the live and
archived parent directories before picking max+1. If you only scanned
the live tree, archiving story 3 would let the next sibling reuse qid
`…:3` — silently shadowing the archived one. Same rule for tasks.

### `Index.apply_record` UPSERTs the item row

Don't change `apply_record` to DELETE-then-INSERT the items row. The
`dependencies` table has `ON DELETE CASCADE` on both `source_id` and
`target_id`, so deleting an item also wipes every edge *into* it.
Those incoming edges are owned by *other* items' frontmatter; losing
them silently caused a bug where depending-on relationships
disappeared on any unrelated status change. The current code uses
`INSERT ... ON CONFLICT DO UPDATE` for items and only manually purges
this item's outgoing tags + deps.

### Only `done` satisfies a dependency

The `find_pickable` SQL and `compute_blockers` both check `status !=
'done'` literally — custom statuses like `completed` do *not* satisfy.
If you ever generalize, update both sites and the test in
`test_deps.py::test_custom_status_does_not_satisfy_dep`.

### `close --if-children-done` does not vacuously close empty containers

A story with no tasks or an epic with no stories returns `False` from
`loom.close_if_children_done`. Use `Item.complete()` for an explicit
close. This prevents "close everything empty" surprises; locked in by
tests in `test_deps.py`.

### `Loom()` does NOT create directories

`Loom.__init__` is non-destructive: it never calls `mkdir`. If the DB
exists at `user_version=0` (e.g. someone constructed `Loom()` against a
DB created by something other than `bootstrap.init`), it stamps the
version. Otherwise it touches nothing. This deliberately surfaces
typo'd `root=` paths as errors at first use rather than silently
materializing them. `bootstrap.init()` (or `loom init`) is still the
way to create the directory and a fresh DB.

### `MARKDOWN_SPEC.md` is a stable public contract

`docs/MARKDOWN_SPEC.md` is what external tools rely on when reading or
writing loom files. Non-breaking additions are fine, but format
changes that aren't backwards compatible MUST bump `schema_version`
and ship a migration.

### Other conventions

- **`body_hash` is sha256 of the raw on-disk bytes**, never of
  parsed-and-rerendered content. Hashing the parsed form would produce
  spurious drift after any idempotent re-render.
- **`ValidationIssue.kind` strings are a stable contract** for JSON
  consumers. Add new kinds as `KIND_*` constants in `validation.py`;
  don't inline string literals.
- **Epic ID alphabet:** `abcdefghjkmnpqrstvwxyz23456789` (30 chars,
  excludes `0/1/i/l/o/u`). When picking sample IDs in code or docs,
  pick characters from this alphabet — `a1t467x` is invalid.

## Test conventions

- `tests/conftest.py` provides:
  - `loom_dir` fixture — a freshly initialized `$LOOM_DIR` at `tmp_path`.
  - `write_item()` helper — creates syntactically valid items at the
    canonical path. Use this instead of constructing markdown by hand.
  - An autouse fixture that `chdir`s into `tmp_path`, so the workspace
    walk-up (`state.find_workspace_dir`) starts in a clean tree.
- `tests/test_e2e.py` covers the full project→epic→story→task chain
  through both library and CLI. When you ship a new feature, add an
  e2e test covering both surfaces.
- CLI tests use `typer.testing.CliRunner` and pass `--root` explicitly
  so they don't touch the real `$LOOM_DIR`. CliRunner is non-TTY; that
  is the load-bearing reason existing tests behave as before despite
  the interactive CLI ergonomics.
- For interactive flows, patch `prompts.is_interactive` (not
  `sys.stdin.isatty`) — CliRunner replaces stdin during `invoke`, so
  the latter doesn't survive.
- Reject-cases are as important as happy-paths for `ids.parse_qid`.
  See the parametrized rejection tests in `tests/test_ids.py`.
- `loom project create` from non-git cwds requires `--repo`; tests that
  use it without git context must pass `--repo` explicitly.

## Workflow expectations

- Consult the `advisor` tool before committing to a non-trivial design
  decision and again before declaring work complete.
- Use `gitnexus_impact` before editing a symbol; `gitnexus_detect_changes`
  before committing. See the GitNexus block below.
- The CLI is built with `typer`. A single root `@app.callback()` is
  required for it to behave as a multi-command app; don't remove it.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **loom** (1870 symbols, 4129 relationships, 165 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/loom/context` | Codebase overview, check index freshness |
| `gitnexus://repo/loom/clusters` | All functional areas |
| `gitnexus://repo/loom/processes` | All execution flows |
| `gitnexus://repo/loom/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
