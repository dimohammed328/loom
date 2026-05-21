# loom

A markdown-based, hierarchy-agnostic project management library and CLI.

`projects → epics → stories → tasks`, with cross-cutting dependencies.
Markdown files on disk are the source of truth; a SQLite index makes
queries fast. Three intended consumers — humans (CLI), programs
(Python library), and AI agents — none privileged.

## Why loom

- **Your data is plain text.** Every item is one `.md` file with YAML
  frontmatter under `$LOOM_DIR/projects/`. `grep`, `vim`, `git`, and
  `find` all work. Hand-edit a file or rename a directory; `loom rebuild`
  reconciles.
- **The file format is a public contract.** External tools can read
  and write loom files directly — see [`docs/MARKDOWN_SPEC.md`](docs/MARKDOWN_SPEC.md).
- **Cross-cutting dependencies.** Any non-project item can depend on
  any other non-project item — across stories, epics, and projects.
- **Pickability is computed.** `loom ready` returns items whose status
  is `ready` and whose dependencies are all `done`.

Out of scope: agent-specific behavior, full-text search, file-watch
auto-sync, web UI, multi-user permissions. Loom is a library plus
CLI, not a platform.

## Install

Loom is a Python 3.11+ project managed with [uv](https://docs.astral.sh/uv/).

```bash
git clone <this repo>
cd loom
uv sync
uv run loom --help
```

To use the library from another project:

```bash
uv add <path-or-git-url>/loom
```

## $LOOM_DIR

Loom resolves its data directory in this order:

1. `$LOOM_DIR` if set
2. `$XDG_DATA_HOME/loom`
3. `~/.local/share/loom`

`loom init` creates the directory and the SQLite index. Idempotent —
safe to re-run.

```bash
LOOM_DIR=/tmp/scratch uv run loom init
```

## CLI quick tour

```bash
# Initialize a fresh store
loom init

# Build the hierarchy
loom project create acme --title "Acme" --repo https://github.com/acme/acme
loom epic    create acme           --title "Add OAuth"
loom story   create acme:apt2467   --title "Backend pieces"
loom task    create acme:apt2467:1 --title "Wire Google provider"

# Navigate
loom show acme:apt2467:1:1
loom list  --type task --status ready
loom ready --type task --json

# Mutate
loom update   acme:apt2467:1:1 assignee alice
loom update   acme:apt2467:1:1 branch   feat/oauth-google
loom tag add  acme:apt2467:1:1 auth security
loom complete acme:apt2467:1:1

# Dependencies
loom dep add  acme:apt2467:1:2 --on acme:apt2467:1:1
loom dep list acme:apt2467:1:2

# Subtree close
loom close acme:apt2467 --if-children-done

# Maintenance
loom validate
loom rebuild
loom sync acme:apt2467:1:1
```

`--json` is supported on every read-side command (`list`, `ready`,
`statuses`, `validate`, `dep list`, `show`, `project list`, `rebuild`).

### Interactive ergonomics

When you omit a required positional (a parent qid, the qid to mutate, a
field name, …), loom prompts:

- **Lookup-style inputs** (parent qid, item qid, target qid) launch
  [`fzf`](https://github.com/junegunn/fzf) over the candidates, with the
  last-touched value preselected. If `fzf` isn't on `$PATH`, a numbered
  list picker is used instead.
- **Free-form inputs** (title and body for `create`; title for `update`)
  open `$EDITOR` — on a temp file with a frontmatter template for new
  items, or on the existing item file when updating.

`loom project create <name>` discovers the repo URL from `cwd`'s
`origin` remote automatically; pass `--repo URL` explicitly to bypass.
The cwd must be inside a git repo with an `origin` remote (or pass
`--repo`). On success, a `.loom/` workspace directory is anchored at
the git toplevel (or cwd when `--repo` is given outside git).

The workspace stores a reference to the bound loom project plus the
last-touched epic / story / task. Subsequent `loom` invocations from
anywhere inside the workspace (walking up to find `.loom/`) auto-fill
defaults:

- `loom epic create` uses the workspace's bound project — no picker.
- `loom story create` preselects the last-touched epic.
- `loom task create` preselects the last-touched story.
- Other commands (`update`, `show`, `dep add`, …) preselect the most
  specific last-touched id.

`.loom/` ships with its own `.gitignore` (`*`) so it stays out of your
git index. Pass `--non-interactive` (or `-y`) to disable all prompts
and require explicit arguments — useful for scripts.

## Library quick tour

```python
from loom import Loom

loom = Loom()                                       # uses $LOOM_DIR
project = loom.create_project(
    "acme",
    title="Acme",
    repo="https://github.com/acme/acme",
    default_branch="main",
)
epic    = project.create_epic(title="Add OAuth")
story   = epic.create_story(title="Backend pieces")
task    = story.create_task(title="Wire Google")

# Setters are chainable; mutations write the file *and* update the index
# atomically. The instance you mutated reflects the change immediately;
# other in-memory copies must call `.refresh()`.
task.set_assignee("alice").set_branch("feat/oauth-google").add_tag("auth")

# Dependencies
task.depends_on("acme:apt2467:1:1")    # raises CycleError on cycle, NotFound on missing target
task.is_pickable()                     # status='ready' AND every dep is done
task.blockers()                        # list[ItemRef] not yet done

# Queries
loom.find(type="task", status="ready", tag="auth")
loom.ready(type="task", limit=10)      # pickable items
loom.statuses()                        # every distinct status in use
loom.close_if_children_done("acme:apt2467")

# Maintenance
loom.sync("acme:apt2467:1:1")
loom.rebuild()                         # drop + repopulate index
loom.validate()                        # report drift, broken deps, etc.
```

## Status semantics

Three canonical statuses (`ready`, `blocked`, `done`) plus arbitrary
custom strings. **Only `done` has semantic effect** — it satisfies
dependencies. `ready` is the default for new items and gates the
`ready` query. Everything else is a label loom doesn't interpret. See
`docs/MARKDOWN_SPEC.md#status-semantics` for the full contract.

## Exit codes (CLI)

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic error (also: `validate` / `rebuild` reporting any issue) |
| 2 | Item not found |
| 3 | Item already exists |
| 4 | Adding the dependency would create a cycle |
| 5 | Invalid qualified id or reserved project name |

Scripts can rely on these. New codes will be added but existing
mappings will not change.

## Concurrency

Loom is single-writer-per-item. **It does not arbitrate concurrent
writes.** Reads are always safe; writes to different items from
different processes are safe; writes to the same item may race
(last-writer-wins on the file, the index resyncs from disk). If you
need stronger guarantees, layer them above loom.

## Documentation

- [`docs/MARKDOWN_SPEC.md`](docs/MARKDOWN_SPEC.md) — the public file format contract
- [`CLAUDE.md`](CLAUDE.md) — repo conventions, architecture invariants, gotchas

## License

TBD.
