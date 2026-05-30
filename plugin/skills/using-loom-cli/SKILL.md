---
name: using-loom-cli
description: >
  Consult this skill before invoking any loom CLI command. It documents every
  loom subcommand used in the loom planning workflow — real flags
  (verified from live `loom <cmd> --help`), usage syntax, and one canonical
  example per subcommand. Use it to look up correct flag names and argument
  order so you do not guess or invent flags.
---

# Using Loom

Loom is a markdown-based, hierarchy-agnostic project management CLI.
Items are stored as markdown files in a `.loom/` workspace directory.
Every item has a **qualified id (qid)** in the form `<project>:<random>` for
projects/epics/stories, and `<project>:<random>:<n>` for tasks.

---

## CRITICAL: The `-y` / `--non-interactive` Flag Is a GLOBAL Option

> **`-y` / `--non-interactive` is a TOP-LEVEL flag on the `loom` command
> itself. It is NEVER a flag on a subcommand.**
>
> Correct:   `loom -y story create --title "My story" myepic`
> Incorrect: `loom story create -y --title "My story" myepic`
>
> Passing `-y` after a subcommand name will cause an error.
> Always place `-y` immediately after `loom`, before the subcommand.

---

## Subcommand Reference

### `project create`

Create a new project. The current directory must be a git repo with an
`origin` remote, or pass `--repo` explicitly.

```
Usage: loom project create [OPTIONS] NAME

Arguments:
  name  TEXT  Project slug — must match ^[a-z][a-z0-9-]{0,63}$. [required]

Options:
  --title TEXT          Human-readable title.
  --body TEXT           Markdown body for the project file.
  --body-file PATH      Path to a markdown file used as the body.
                        Mutually exclusive with --body.
  --repo TEXT           Upstream / origin URL. Auto-discovered from
                        cwd's git origin if omitted.
  --default-branch TEXT Default git branch.
  --root PATH           Override $LOOM_DIR for this invocation.
  --help                Show this message and exit.
```

**Example:**

```bash
loom -y project create --title "My Project" myproject
```

---

### `epic create`

Create a new epic under a project.

```
Usage: loom epic create [OPTIONS] [PROJECT]

Arguments:
  project  [PROJECT]  Project name (qid). Interactive picker if omitted.

Options:
  --title TEXT         Human-readable title.
  --body TEXT          Markdown body.
  --body-file PATH     Path to a markdown file used as the body.
                       Mutually exclusive with --body.
  --root PATH          Override $LOOM_DIR for this invocation.
  --help               Show this message and exit.
```

**Example:**

```bash
loom -y epic create --title "Authentication Overhaul" myproject
```

---

### `story create`

Create a new story under an epic. Passing a bare project qid defaults to
the project's `backlog` epic, creating it on the fly if needed.

```
Usage: loom story create [OPTIONS] [EPIC_QID]

Arguments:
  epic_qid  [EPIC_QID]  Qualified id of the parent epic. Picker if omitted.

Options:
  --title TEXT         Human-readable title.
  --body TEXT          Markdown body.
  --body-file PATH     Path to a markdown file used as the body.
                       Mutually exclusive with --body.
  --root PATH          Override $LOOM_DIR for this invocation.
  --help               Show this message and exit.
```

**Example:**

```bash
loom -y story create --title "Add login endpoint" --body-file story.md myproject:abc123
```

---

### `task create`

Create a new task under a story.

```
Usage: loom task create [OPTIONS] [STORY_QID]

Arguments:
  story_qid  [STORY_QID]  Qualified id of the parent story. Picker if omitted.

Options:
  --title TEXT         Human-readable title.
  --body TEXT          Markdown body.
  --body-file PATH     Path to a markdown file used as the body.
                       Mutually exclusive with --body.
  --root PATH          Override $LOOM_DIR for this invocation.
  --help               Show this message and exit.
```

**Example:**

```bash
loom -y task create --title "Write failing test for login" myproject:abc123:1
```

---

### `dep add`

Add a dependency edge: `<qid>` depends on `--on <target>`.
The source item cannot be scheduled until the target item is done.

```
Usage: loom dep add [OPTIONS] [QID]

Arguments:
  qid  [QID]  Source: the item that depends on something. Picker if omitted.

Options:
  --on TEXT    Target qualified id. Picker if omitted.
  --root PATH  Override $LOOM_DIR for this invocation.
  --help       Show this message and exit.
```

**Example:**

```bash
loom -y dep add myproject:abc123:2 --on myproject:abc123:1
```

---

### `order`

Return descendants of `<qid>` in topological dep-order (dependencies first).
This is the authoritative task ordering for story executors.

```
Usage: loom order [OPTIONS] QID

Arguments:
  qid  TEXT  Qualified id to enumerate descendants of. [required]

Options:
  --recursive     Include all descendants, not just direct children.
  --include-done  Include done items in the result.
  --json          Emit JSON array.
  --root PATH     Override $LOOM_DIR for this invocation.
  --help          Show this message and exit.
```

**Example:**

```bash
loom order --json myproject:abc123:1
```

---

### `ready`

List pickable items: status=`ready` and every dep is done.
Optionally scope to a parent qid.

```
Usage: loom ready [OPTIONS] [QID]

Arguments:
  qid  [QID]  Optional parent qid; scope to items under it.

Options:
  --type TEXT     Filter by type (epic|story|task).
  --tag TEXT      Filter to items carrying this tag.
  --limit INTEGER Cap the number of results.
  --recursive     Include all descendants of <qid>, not just direct children.
  --json          Emit as JSON.
  --root PATH     Override $LOOM_DIR for this invocation.
  --help          Show this message and exit.
```

**Example:**

```bash
loom ready --type story --json myproject:abc123
```

---

### `show`

Print an item's markdown file to stdout (frontmatter + body, as-is).

```
Usage: loom show [OPTIONS] [QID]

Arguments:
  qid  [QID]  Qualified id of the item to print. Picker if omitted.

Options:
  --json       Emit {qualified_id, frontmatter, body} as JSON.
  --root PATH  Override $LOOM_DIR for this invocation.
  --help       Show this message and exit.
```

**Example:**

```bash
loom show --json myproject:abc123:1
```

---

### `update`

Update a single frontmatter field on an item.
For `body`, use `--body-file` to read the new body from a file.

```
Usage: loom update [OPTIONS] [QID] [FIELD] [VALUE]

Arguments:
  qid    [QID]    Qualified id of the item to mutate. Picker if omitted.
  field  [FIELD]  Field name (title, body, status, assignee, branch,
                  pr_url, repo, default_branch).
  value  [VALUE]  New value. Use an empty string to clear an optional field.

Options:
  --body-file PATH  When field=body, read the new body from this file.
  --root PATH       Override $LOOM_DIR for this invocation.
  --help            Show this message and exit.
```

**Example:**

```bash
loom update myproject:abc123:1 status in_progress
loom update myproject:abc123:1 assignee session-abc:agent-xyz
```

---

### `complete`

Set an item's status to `done`.

```
Usage: loom complete [OPTIONS] [QID]

Arguments:
  qid  [QID]  Qualified id of the item to mark done. Picker if omitted.

Options:
  --root PATH  Override $LOOM_DIR for this invocation.
  --help       Show this message and exit.
```

**Example:**

```bash
loom complete myproject:abc123:1
```

---

### `validate`

Report inconsistencies between the index and the filesystem.
Exits non-zero if any issues are found.

```
Usage: loom validate [OPTIONS]

Options:
  --root PATH  Override $LOOM_DIR for this invocation.
  --json       Emit issues as a JSON array on stdout.
  --help       Show this message and exit.
```

**Example:**

```bash
loom validate --json
```

---

### `tree`

Render the subtree rooted at `<qid>` as a visual tree.

```
Usage: loom tree [OPTIONS] QID

Arguments:
  qid  TEXT  Qualified id to render as a tree. [required]

Options:
  --depth INTEGER  Limit descent: 1 = direct children only.
  --status TEXT    Filter items to this status.
  --json           Emit the flat-array JSON shape.
  --root PATH      Override $LOOM_DIR for this invocation.
  --help           Show this message and exit.
```

**Example:**

```bash
loom tree --depth 2 myproject:abc123
```

---

## Quick Reference

| Subcommand       | Purpose                                          |
|------------------|--------------------------------------------------|
| `project create` | Create a new project bound to a git repo         |
| `epic create`    | Create an epic under a project                   |
| `story create`   | Create a story under an epic (or project backlog)|
| `task create`    | Create a task under a story                      |
| `dep add`        | Declare that one item depends on another         |
| `order`          | Topological task list for a story/epic           |
| `ready`          | Items that are unblocked and ready to work       |
| `show`           | Print an item's full markdown to stdout          |
| `update`         | Set a single frontmatter field on any item       |
| `complete`       | Mark an item done                                |
| `validate`       | Check index/filesystem consistency               |
| `tree`           | Visual subtree render                            |
