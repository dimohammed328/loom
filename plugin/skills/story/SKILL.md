---
name: story
description: "Use when the user types /story followed by a description of a small, scoped change — a bugfix, single-file refactor, or self-contained feature. Plans the work as a loom story with tasks under the project's backlog epic, executes it via one story-executor subagent, validates, and finalizes the branch."
---

# /story — single-story workflow

The story-scale sibling of `loom:epic`: same orchestrator role, no trunk, no
merge gate, one executor. The description is in `$ARGUMENTS`; your session id
is `${CLAUDE_SESSION_ID}`.

**Scale check first.** If the request needs multiple coordinated stories,
promote it to the `loom:epic` flow and say so.

**Finalize mode is derived mechanically, never asked**: `merge` only when the
request explicitly said to merge to main; otherwise — including silence —
`pr`. Never ask.

The **Loom CLI facts** section of `loom:epic` applies verbatim (-y is global,
`create` prints the bare qid on stdout, `--body-file` for bodies, dep
direction and exit-code-4 cycles, only literal `done` satisfies deps, tasks
carry no assignee).

## Phase 1 — Bind

`loom status --json` → `.project`. If unbound, `loom -y project create
<repo-basename>`; fail plainly outside a git repo. The story's parent is the
project's `backlog` epic: passing the bare project qid to `loom story create`
targets it (auto-created if missing).

## Phase 2 — Research and groom (gate 1)

Ground the change in the actual code (files, symbols, callers) — inline
research is usually enough at story scale. **Scale the groom to the ask**: for
an unambiguous small fix, ask nothing and go straight to a short draft; ask at
most a couple of questions when the request is genuinely underspecified. Don't
let a trivial fix sit blocked on clarifying questions.

Draft, presented as an ordinary plain-text message (never AskUserQuestion for
approval), then wait for the typed reply:

- title
- body: `## Summary`, `## Context`, `## Validation Criteria` (observable
  checklist), `## Implementation Notes`, `## Out of Scope`
- ordered tasks — each one commit's worth of coherent work; no single-line
  shreds, no process-step tasks ("run tests" is part of every task)

## Phase 3 — Materialize (gate 2 — lightweight)

```bash
STORY=$(loom -y story create <project> --title "…" --body-file "$TMP/story.md" --assignee "${CLAUDE_SESSION_ID}")
loom -y task create "$STORY" --title "…" --body-file "$TMP/t1.md"
…
```

At least one task — `loom order` drives the executor and an empty list aborts
it. Intra-task deps only for genuine prerequisites; creation order already
sequences the list. Materialization happens after draft approval; show
`loom tree "$STORY"` as you proceed — for a small story the tree is
informational and needs no second sign-off. Don't stage a second ceremony.

## Phase 4 — Execute

Dispatch one `story-executor` subagent with `story_qid`, `parent_branch`
(the project's default branch), and the repo root. It creates or resumes a
deterministic worktree under `<repo>/.claude/worktrees/`, implements each
task with TDD, commits per task, and reports `{story_qid, branch, worktree,
summary}`.

Validate its work yourself — don't take the report's word: check each
`## Validation Criteria` item against the worktree, run the test suite there.
On failure, re-dispatch the executor with `fix_notes` (it resumes the same
branch). Budget: **three dispatches, counting the first**, then the
small-gap rule from `loom:epic` applies — fix a few-line gap yourself in the
story worktree, re-run the failing checks, disclose it; or stop and report if
the gap is real implementation work.

## Phase 5 — Finalize and report

Only after validation passes:

```bash
git push -u origin <branch>
gh pr create --title "…" --body "…"     # finalize=pr (default)
# or merge into the default branch and push — only when explicitly requested AND validation passed
loom update "$STORY" branch "<branch>"
loom update "$STORY" pr_url "<url>"     # skip when finalize=merge
loom complete "$STORY"                  # after the push lands — done means the code is out
```

(Tasks were already completed by the executor as it went.)

Report: what shipped, validation outcome (failures first, plainly), anything
hand-finished, the PR link. Remove the worktree once the branch is pushed.

## What you never do

- Implement the story inline (the disclosed small-gap fix is the only
  exception).
- `loom complete` the story before its branch is validated and pushed.
- Ask merge-vs-PR; use AskUserQuestion for draft approval; write plan files.
