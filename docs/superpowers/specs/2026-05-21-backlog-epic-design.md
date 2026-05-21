---
date: 2026-05-21
status: approved, ready for plan
---

# Default `backlog` epic for every project

## Problem

Every loom project starts empty: a `project.md` and nothing else. To
record a one-off bug fix or small patch, the user must first invent an
epic — even though epics are meant to bound a coherent, multi-story
body of work, not hold a single throwaway item.

The result is friction at the most common entry point (small fixes)
and inconsistency across projects: some grow a "misc" epic, some
scatter loose work under arbitrary epics, some never record it at all.

## Goals

- Every loom project has a known, predictable home for one-off work.
- That home is addressable by a stable, typeable name: `<project>:backlog`.
- CLI ergonomics make defaulting cheap: passing a bare project qid to
  `story create` lands the story under backlog.

## Non-goals

- Defaulting `task create <project>` to a synthesized story under backlog.
  Decided in brainstorm: stories under backlog ARE the one-off work units;
  if a story grows tasks, the user creates them explicitly under it.
- Backfilling backlog into pre-existing projects via `loom rebuild`.
  Rebuild stays a pure index regen. Legacy projects get backlog
  lazy-created the first time `story create` defaults into them.
- Changes to `epic create`, dep/ready/close semantics, or any picker
  beyond `story create`'s preselection rule.

## Design

### 1. Epic ID rule: 7-char alphabet OR literal `backlog`

`ids.py` today defines the epic ID as exactly seven characters from
`abcdefghjkmnpqrstvwxyz23456789` (Crockford-ish, excludes
`0/1/i/l/o/u`). The change: accept either that pattern **or** the
literal string `backlog`.

```python
BACKLOG_EPIC_ID = "backlog"

def _is_valid_epic_id(s: str) -> bool:
    return s == BACKLOG_EPIC_ID or bool(EPIC_ID_RE.match(s))
```

`_is_valid_epic_id` is wired into both `parse_qid` (string → qid) and
`qid_from_path` (filesystem → qid). The on-disk path for the backlog
epic is literally `epics/backlog/`, preserving the path↔qid bijection.

`random_epic_id` needs no change: the alphabet excludes `o` and `l`,
so a random allocation can never produce `backlog`. No collision risk
between random and reserved IDs.

This change updates the non-negotiable in `CLAUDE.md` ("Epic ids are
unique within a project; 7 chars from `EPIC_ALPHABET`") to add the
literal exception. The user has explicitly approved this change.

**Schema version implication.** The epic ID format widens. A v1 reader
that hard-validates against the old regex would reject a v2 file with
a `backlog` epic, so the format is forward-incompatible. Per the
`MARKDOWN_SPEC.md` contract, `schema_version` bumps from 1 to 2.
Nothing in loom's code enforces the version field, so no migration
code is needed — this is documentation that lets external readers
detect the change. New items write `schema_version: 2`; old items
keep `1` and continue to be readable.

### 2. Eager creation on `Loom.create_project`

Extend `Project.create_epic` to accept an optional `epic_id` kwarg.
When supplied, the method skips its random-allocation retry loop and
uses the provided ID directly. Default behavior (no kwarg) is
unchanged.

`Loom.create_project` calls
`project.create_epic(title="Backlog", epic_id=BACKLOG_EPIC_ID)` right
after writing the project file. Both surfaces benefit:

- CLI: `loom project create acme` writes `acme` + `acme:backlog`.
- Library: `Loom(...).create_project("acme", title="A")` does the
  same. Library consumers get the same guarantee as CLI consumers.

**Failure mode.** If backlog creation fails after the project file is
written, the project exists in a half-built state. We do NOT roll
back the project file. The CLI surfaces a stderr warning along the
lines of:

> `project created; backlog epic creation failed (<reason>) — run
> 'loom rebuild', then re-run 'loom project create <name>' or create
> the backlog epic manually.`

This matches the advisor's guidance — rollback gymnastics aren't
worth it for a code path that, in practice, only fails on disk-full
or permission errors.

**Workspace side effects.** The backlog auto-creation does NOT update
the workspace's `last_epic`. `_record_touch` continues to fire on the
project qid only (existing behavior). The user's last-touched epic
should reflect intentional action, not a side effect.

### 3. CLI defaulting in `story_create`

In `cli.py:story_create`, after the user supplies `epic_qid`:

```python
parsed = parse_qid(epic_qid)
if parsed.type is ItemType.PROJECT:
    epic_qid = f"{parsed.project}:{BACKLOG_EPIC_ID}"
    # Lazy-create backlog for legacy projects pre-dating this change.
    if loom.get_or_none(epic_qid) is None:
        project = loom.get(parsed.project)
        project.create_epic(title="Backlog", epic_id=BACKLOG_EPIC_ID)
```

Library API stays strict: `parent.create_story` called on a `Project`
still raises a type error. CLI convenience, library precision.

Interactive mode (no `epic_qid` given): the preselect calculation
becomes

```python
preselect = defaults.epic or (
    f"{workspace.project}:{BACKLOG_EPIC_ID}" if workspace and workspace.project else None
)
```

A fresh user with no last-touched epic gets backlog as the fzf
`--query` seed and the numbered-picker default. Once they touch a
real epic, that wins.

### 4. Picker behavior

No changes to `prompts.py` or candidate rendering. Backlog epics show
up like any other epic (`type=epic, status=ready`). fzf users filter
naturally; numbered-fallback users see one extra entry per project.
The preselection rule in (3) is the only picker-touching change.

### 5. Out-of-scope but worth noting

- `loom epic create` is unchanged. It always creates a new
  random-ID epic. Backlog is created by `project create`, not by
  `epic create`.
- `dep add`, `ready`, `close`, `archive` are unchanged. Backlog
  epics participate in those flows exactly like any other epic.

## Test plan

**ids:**
- `parse_qid("acme:backlog")` returns `QualifiedId("acme", "backlog")`
- `path_from_qid` ↔ `qid_from_path` round-trip for backlog (live and
  archive)
- `parse_qid("acme:backlogx")` still rejects (not exactly `backlog`,
  not 7 chars from alphabet)
- `parse_qid("acme:backloX")` still rejects (case-sensitive)

**items / api:**
- `Loom.create_project("acme", title="A")` writes both
  `projects/acme/project.md` and
  `projects/acme/epics/backlog/epic.md`
- The new epic has `title="Backlog"`, `status="ready"`
- `loom.find(type="epic")` returns the backlog
- `Project.create_epic(title="x", epic_id="backlog")` works when
  called explicitly; a second call raises `Duplicate`

**CLI:**
- `loom project create acme` → backlog exists on disk
- `loom story create acme --title S` → creates `acme:backlog:1`
- Legacy path: a project written via `write_item` (no backlog) gets
  backlog lazy-created the first time `loom story create <project>`
  defaults into it
- `loom project create backlog` (a project literally named `backlog`)
  → qids like `backlog:backlog` round-trip through parse + path
  (advisor-flagged edge case)

**Existing tests to update:**
- `test_phase5.py::test_rebuild_json_clean`: `indexed_count` 1 → 2
  after `create_project`
- Other count-based assertions identified during implementation
  (sweep `find(type="epic")` and any `.epics()` length checks)

## Migration / rollout

Dev-mode project; no external users. No code migration needed because
`parse_qid` strictly widens its accepted set — v1 files remain valid
under v2 parsing. `MARKDOWN_SPEC.md` documents schema 2 and the new
epic ID rule. The `CLAUDE.md` non-negotiable #2 gets the literal
`backlog` exception added.

## Risks

- **Test churn.** Roughly 4-5 existing tests count items and will need
  +1 updates. Bounded; surfaced by running the suite.
- **Picker noise** for users with many projects: each project
  contributes one backlog epic to the picker list. Mitigated by fzf
  filtering; numbered fallback degrades gracefully (still ordered,
  still searchable by typing).
- **Half-built project on backlog-creation failure.** Deliberately
  not rolled back. The CLI failure message tells the user how to
  recover.
