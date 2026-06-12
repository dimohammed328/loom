---
name: epic
description: "Use when the user types /epic followed by a description of a large feature, refactor, or end-to-end change that spans multiple stories. Plans the work as a loom epic with child stories and tasks, executes stories via parallel story-executor subagents, validates, and finalizes the branch."
---

# /epic — multi-story workflow

You are the orchestrator for the whole run. You plan in conversation, record
the plan in loom, dispatch one `story-executor` subagent per story, merge their
branches serially, validate, and finalize. Executors own implementation; you
own everything else. The description is in `$ARGUMENTS`; your session id is
`${CLAUDE_SESSION_ID}`.

**Scale check first.** If the request is one story's worth of work (a bugfix, a
single scoped change), say so and follow `loom:story` instead. Don't force epic
ceremony onto a small fix. Likewise `/story` requests that turn out to need
multiple coordinated stories should be promoted to this flow.

**Finalize mode is derived mechanically, never asked.** Use `merge` only when
the request explicitly said to merge (e.g. "merge to main", "push to main",
"no PR"). In every other case — including silence on the topic — use `pr`.
Never ask the user to choose, in prose or via AskUserQuestion. Unsure means `pr`.

## Loom CLI facts

- `-y` / `--non-interactive` is a **global** flag: `loom -y epic create …`,
  never `loom epic create -y …`. Without it, missing arguments open
  interactive pickers that hang a non-TTY session.
- Every `create` prints the **bare qid on stdout** (`created <qid>` goes to
  stderr), so `QID=$(loom -y story create …)` captures cleanly.
- Bodies always go through `--body-file` (write them in a `mktemp -d` dir),
  never `--body` with multi-paragraph strings.
- Dependency direction: `loom -y dep add <source> --on <target>` means
  *source waits for target*. A cycle is rejected with exit code 4 — that means
  the plan is malformed; fix the plan, don't retry.
- **Only the literal `done` status satisfies a dependency.** `in_progress`,
  `completed`, or any custom status does not. `loom complete <qid>` is the
  only way work unblocks its dependents.
- Epics and stories carry `--assignee "${CLAUDE_SESSION_ID}"`; tasks never
  carry an assignee.
- Useful reads: `loom show <qid> --json` (frontmatter + body),
  `loom order --json <qid>` (open descendants, deps-first),
  `loom ready --type story --json <qid>` (unblocked stories under a parent),
  `loom tree <qid>`, `loom validate --json`.
- Scope changes: `loom -y archive <qid>` moves an item (and subtree) out of
  the live tree when the user drops it; `loom reopen <qid>` resets a subtree
  to `ready` for a rerun. Never hard-delete.

## Phase 1 — Bind

Run `loom status --json` and read `.project`. If it fails (no workspace),
run `loom -y project create <repo-basename>` (auto-discovers the `origin`
remote; fails outside a git repo — surface that and stop; there is no
non-loom fallback).

## Phase 2 — Research

Ground the plan in the actual codebase before asking the user anything: find
the files, symbols, and patterns the change touches, and gauge blast radius
(grep for callers). Do it inline for focused changes; spawn an `Explore`
subagent for broad sweeps so the file dumps stay out of your context. Never
skip research — it is what makes validation criteria observable rather than
hand-wavy.

## Phase 3 — Groom (gate 1)

Ask the clarifying questions the research surfaced — purpose, constraints,
success criteria, out-of-scope. Scale to the ask: an unambiguous request may
need zero questions; never more than a handful. AskUserQuestion is fine here.

Then assemble the draft plan in conversation (no file is written):

- **Epic**: title + body with `## Summary`, `## Context` (files/symbols from
  research), `## Validation Criteria` (observable checklist — behaviors,
  files, test outcomes; no implementation detail like "uses a hashmap"),
  `## Implementation Notes`, `## Out of Scope`.
- **Stories**: same body shape, each with an ordered task list. A task is one
  commit's worth of work — a coherent, verifiable change. Don't shred work
  into single-line tasks, and don't file process steps ("run the tests",
  "verify visually") as tasks; testing is part of every task.
- **Story deps**: real edges (B needs A's output), plus sequencing edges
  when two otherwise-independent stories would edit the same files —
  concurrent executors on one file waste every run but one. A pure
  sequencing edge's direction is your call; pick the more natural review
  order.
- Within a story, task order is the creation order; `loom order` preserves it.
  Add intra-story dep edges only for genuine prerequisites, not to encode
  sequence.

**Present the draft as an ordinary plain-text message, end your turn, and wait
for the user's typed reply.** Never use AskUserQuestion for draft approval —
the question UI hides the very plan being approved. Iterate until approved.

## Phase 4 — Materialize (gate 2)

Write one body file per item in a temp dir, then create everything,
capturing qids:

```bash
EPIC=$(loom -y epic create <project> --title "…" --body-file "$TMP/epic.md" --assignee "${CLAUDE_SESSION_ID}")
STORY1=$(loom -y story create "$EPIC" --title "…" --body-file "$TMP/s1.md" --assignee "${CLAUDE_SESSION_ID}")
loom -y task create "$STORY1" --title "…" --body-file "$TMP/s1t1.md"
…
loom -y dep add "$STORY2" --on "$STORY1"
```

Every story needs at least one task — `loom order` is the executor's work
loop and an empty list aborts it. No "TBD" placeholders in criteria; if the
criteria are vague, the groom isn't done.

Then `loom validate` and `loom tree "$EPIC"`; show the tree and get the
user's sign-off. Apply requested changes with `loom -y update` /
`loom -y dep add|rm` / `loom -y archive`.

## Phase 5 — Execute

### Trunk setup

Derive `SLUG` from the epic qid with colons replaced by hyphens (git refuses
colons in branch names). Create the trunk:

```bash
git worktree add -b "loom/<SLUG>" "<repo>/.claude/worktrees/<SLUG>-trunk" <default-branch>
loom update "$EPIC" branch "loom/<SLUG>"
loom update "$EPIC" status in_progress
```

If trunk setup fails for any reason, **stop the run and report** — never
dispatch a story against a broken or missing trunk.

All worktrees (trunk and stories) live under `<repo>/.claude/worktrees/`;
file edits outside that subtree may be rejected by the harness in background
sessions.

### Scheduling loop

Repeat until no open stories remain under the epic:

1. `loom ready --type story --json "$EPIC"` — the unblocked stories.
2. Dispatch a `story-executor` subagent for **every** ready story in a single
   message so they run concurrently. Each dispatch prompt carries exactly:
   `story_qid`, `parent_branch` (`loom/<SLUG>`), the repo root, and — on
   re-dispatch — `fix_notes` describing what validation found. The executor
   creates (or resumes) its own deterministic worktree and reports
   `{story_qid, branch, worktree, summary}`.
3. As each executor returns, **validate then merge, one story at a time**:
   - Read `loom show <story> --json` and check each `## Validation Criteria`
     item against the worktree (grep/read/run); run the project's test suite
     in the story worktree. You validate — don't take the executor's word.
   - **Pass** → merge in the trunk worktree:
     `git merge --no-ff <branch> -m "Merge story <qid>"`. Resolve only
     trivial, unambiguous conflicts (both-added distinct lines, lockfiles,
     whitespace); for anything touching real logic, `git merge --abort` and
     re-dispatch the executor with `fix_notes` telling it to merge the trunk
     into its branch and resolve — never guess a resolution yourself, and
     never clean up a failed merge's branch or worktree. After the merge
     lands: `loom complete <story>`, then
     `git worktree remove <story-worktree> && git branch -d <branch>`.
   - **Fail** → re-dispatch the same executor with `fix_notes` (it resumes
     its worktree and branch; `loom order` gives it any still-open tasks).
4. Newly satisfied deps make more stories ready; go to 1.

Budget: **three executor dispatches per story, counting the first** (conflict
re-dispatches count too). If a story still fails and the remaining gap is
small (a few lines, a doc touch), fix it yourself in the story worktree,
commit, re-run the checks that were failing, merge — and **disclose it in the
final report**. If the gap is real implementation work, stop and report to
the user; manually finishing large gaps inline is how orchestrator contexts
blow up.

`loom complete` on a story happens **only after its merge lands** — never
before, because `done` immediately unblocks dependents onto the trunk.

## Phase 6 — Epic validation

On the trunk, after all stories are merged:

1. Run the full test suite, lint, and format.
2. Check every epic-level `## Validation Criteria` item with real evidence.
3. If the epic changed runnable behavior, invoke the `verify` skill to
   exercise the app. Any long-lived server starts **in the background** with
   its PID captured, gets a bounded readiness poll (~20 × 1s), and is
   **always killed before you move on**, pass or fail. Never start a server
   in the foreground — it hangs the session and leaks orphans.
4. Failures are yours to fix: apply fix passes on the trunk (directly for
   small fixes, via an executor re-dispatch for large ones) and re-validate,
   up to three passes. Within that budget, skipping a criterion is allowed
   only when it hinges on a question the user must answer (product intent,
   external systems).

Whatever is still open when the budget runs out: with `finalize=pr` the run
still finalizes — the PR discloses the open criteria and the fixes applied.
With `finalize=merge`, an unvalidated trunk is **never merged**: report the
validation state and stop.

## Phase 7 — Finalize and report

```bash
git push -u origin "loom/<SLUG>"
gh pr create --title "…" --body "…"        # finalize=pr (default)
# or: git checkout <default-branch> && git merge --no-ff loom/<SLUG> && git push   # finalize=merge, only if validated
loom update "$EPIC" pr_url "<url>"          # and on each story (they ship in the same PR); skip when finalize=merge
loom complete "$EPIC"
```

Final message, in order: what shipped (per story), validation outcome —
stated plainly first if anything failed, with fixes applied and open criteria
verbatim — anything you hand-finished outside an executor, the PR link, and
`loom tree "$EPIC"` so the user sees the recorded state.

## Recovery

- Session died mid-run? Everything needed to resume is in loom and git:
  find the epic via `loom tree` (the `in_progress` epic assigned to the dead
  session), re-derive finalize from the original request (absent that, `pr`),
  and re-assign the epic to the new session id. Story worktrees/branches are
  deterministic from qids and executors resume in place. Loom state implies
  the phase: open stories → Phase 5 (`loom ready` says what's next); all
  stories done → Phase 6.
- User drops a story mid-run: `loom -y archive <story>`; check nothing
  depended on it (`loom validate`).
- A rerun of a finished story: `loom reopen <story>`, then schedule normally.

## What you never do

- Implement story code inline during Phase 5 (executors own it; the
  small-gap rule above is the only exception, and it must be disclosed).
- Mark anything `done` whose code hasn't landed, or rely on a status other
  than `done` to unblock work.
- Ask merge-vs-PR, or use AskUserQuestion for draft approval.
- Skip research, or write plan files — loom items are the only plan artifact.
