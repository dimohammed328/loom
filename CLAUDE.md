# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a `uv`-managed Python 3.11 project.

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
projects → epics → stories → tasks, with cross-cutting dependencies.
Three intended consumers: humans (CLI), programs (Python library), and AI
agents — none privileged. **The full design is in `PLAN.md`. Read it before
making non-trivial changes.** Decisions confirmed in §2 of PLAN.md are not
re-litigatable without explicit user approval.

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
cli.py          typer app; each subcommand is a thin wrapper over the library
```

Implementation phases (see PLAN.md §10): **Phases 1–5 are complete.**
Phase 3 added item CRUD; Phase 4 added dependencies, the `ready` query,
and `close --if-children-done`; Phase 5 added the public `README.md`,
[`docs/MARKDOWN_SPEC.md`](docs/MARKDOWN_SPEC.md) (the stable file-format
contract), `--json` on every read-side CLI command, and a stable exit
code map (`EXIT_NOT_FOUND=2`, `EXIT_DUPLICATE=3`, `EXIT_CYCLE=4`,
`EXIT_INVALID_ID=5` — see `cli.py`). **Phase 6** (post-v1, optional):
FTS5 search, file-watch auto-sync, per-task directories with attachments.

## The mutator contract (Phase 3)

Every `set_*` / `add_tag` / `complete` / `archive` on an `Item` follows
the same five steps in `items.py`: read file → mutate frontmatter →
atomic dump → rebuild `IndexRecord` → assign to `self._record`. The last
step matters: PLAN.md §8.3's "detached snapshot" rule applies to *other*
in-memory copies, not the instance you just mutated. After
`task.set_title("x")`, the same `task` reads `"x"` immediately; a
sibling `task2 = loom.get(qid)` taken earlier won't until `.refresh()`.

## Sequential ID allocation gotcha

`_next_sequential_id` in `items.py` scans **both** the live and archived
parent directories before picking max+1. If you only scanned the live
tree, archiving story 3 would let the next sibling reuse qid `…:3` —
silently shadowing the archived one. The same rule applies to tasks.

## `Index.apply_record` UPSERTs the item row

Don't change `apply_record` to DELETE-then-INSERT the items row. The
`dependencies` table has `ON DELETE CASCADE` on both `source_id` and
`target_id`, so deleting an item also wipes every edge *into* it —
those edges are owned by other items' frontmatter, and silently losing
them caused a Phase 4 bug (depending-on relationships disappeared
whenever the target was re-applied for any reason, e.g. a status
change). The current code uses `INSERT ... ON CONFLICT DO UPDATE` for
items and only manually purges this item's outgoing tags + deps.

## Only `done` satisfies a dependency

The `find_pickable` SQL and `compute_blockers` both check `status !=
'done'` literally — custom statuses like `completed` do *not* satisfy.
PLAN.md §3.3 makes this explicit; if you ever generalize, update both
sites and the test in `test_deps.py::test_custom_status_does_not_satisfy_dep`.

## `close --if-children-done` semantics

Empty containers (a story with no tasks, an epic with no stories) do
*not* auto-close via this helper — `loom.close_if_children_done` returns
`False`. Use `Item.complete()` for an explicit close. This prevents
"vacuously close everything empty" surprises; locked in by tests in
`test_deps.py`.

## `Loom()` does NOT create directories

`Loom.__init__` is non-destructive: it never calls `mkdir`. If the DB
exists at `user_version=0` (e.g. someone constructed `Loom()` against a
DB created by something other than `bootstrap.init`), it stamps the
version. Otherwise it touches nothing. This deliberately surfaces
typo'd `root=` paths as errors at first use rather than silently
materializing them. `bootstrap.init()` (or `loom init`) is still the
way to create the directory and a fresh DB.

## MARKDOWN_SPEC.md is a stable contract

`docs/MARKDOWN_SPEC.md` is the user-facing version of PLAN.md §5 — it's
what external tools rely on when reading or writing loom files. Treat
it as a stable contract: non-breaking additions are fine, but format
changes that aren't backwards compatible MUST bump `schema_version`
and ship a migration. PLAN.md §5 has a pointer reminding you to keep
the two in sync.

## Conventions worth knowing

- **Epic IDs use a 30-char alphabet** (`abcdefghjkmnpqrstvwxyz23456789`)
  excluding `0/1/i/l/o/u`. An ID like `a1t467x` is **invalid** because
  `1` isn't in the alphabet. When picking sample IDs in code or docs,
  pick characters from this alphabet.
- **`body_hash` is sha256 of the raw on-disk bytes**, never of
  parsed-and-rerendered content. Hashing the parsed form would produce
  spurious drift after any idempotent re-render.
- **`ValidationIssue.kind` strings are a stable contract** for JSON
  consumers. Add new kinds as `KIND_*` constants in `validation.py`;
  don't inline string literals.
- **Status semantics:** `ready`, `blocked`, and `done` are baked-in
  canonical statuses. Any other string is a valid custom status.
  **Only `done` has semantic effect** (satisfying dependencies).
  `ready` is the default for new items and gates the (Phase 4)
  `loom ready` query. There is no registration step.
- **Configurability:** there is intentionally no `config.toml`. Don't
  add one without explicit user approval.
- **Concurrency:** loom does NOT arbitrate concurrent writes to the
  same item. Single-writer-per-item is the caller's responsibility.
  Don't add locks, leases, or claim protocols.

## Test conventions

- `tests/conftest.py` provides the `loom_dir` fixture (a freshly
  initialized `$LOOM_DIR` rooted at `tmp_path`) and a `write_item()`
  helper for creating syntactically valid items at the canonical path.
  Use these instead of constructing markdown by hand.
- `tests/test_e2e.py` covers the full project→epic→story→task chain
  through both the library and the CLI. When you ship a new feature,
  add an e2e test covering both surfaces.
- CLI tests use `typer.testing.CliRunner` and pass `--root` explicitly
  so they don't touch the real `$LOOM_DIR`.
- Reject-cases are as important as happy-paths for `ids.parse_qid`.
  See the parametrized rejection tests in `tests/test_ids.py`.

## Workflow expectations

- Consult the `advisor` tool before committing to a non-trivial design
  decision and again before declaring work complete; this is wired
  into the repo's working style.
- When PLAN.md and the implementation conflict, PLAN.md wins unless
  the user has approved a change.
- The CLI is built with `typer`. A single `@app.callback()` is required
  for it to behave as a multi-command app; don't remove it.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **loom** (634 symbols, 1121 relationships, 27 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
