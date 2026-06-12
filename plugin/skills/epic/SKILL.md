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
  interactive pickers that hang a non-TTY session. The bulk commands
  (`loom apply`, `loom dep apply`) never prompt regardless — `-y` is
  harmless but unnecessary with them.
- **Bulk item creation:** `loom apply plan.json` accepts a **nested** JSON
  file (or `-` for stdin) and emits **bare JSON on stdout** —
  `{"created": […]}` mapping of `ref` → `qid` in depth-first creation order.
  Items nest under their parent via a `children` list; `parent` on a root item
  is the existing project/epic qid; `parent` is forbidden on nested children.
  On validation failure, stdout is `{"errors": [{path, code, message}, …]}` —
  all errors collected in one pass; fix everything in one editing pass, then
  re-apply. Stderr carries human-readable notes; do not parse it.
- **Bulk dependency wiring:** `loom dep apply deps.json` (or `-` for stdin)
  emits `{"added": N}` on stdout. It runs one batch cycle check over the
  existing graph plus all new edges together — a cycle exits 4 and applies
  nothing. Already-existing edges are idempotent (counted as 0 in `added`).
- Dependency direction in both `dep add` and `dep apply`: `source` waits for
  `on` / `target`. A cycle is rejected with exit code 4 — that means the
  plan is malformed; fix the plan, don't retry.
- **Only the literal `done` status satisfies a dependency.** `in_progress`,
  `completed`, or any custom status does not. `loom complete <qid>` is the
  only way work unblocks its dependents.
- Epics and stories carry `assignee` (set to `"${CLAUDE_SESSION_ID}"` in the
  plan JSON); tasks never carry an assignee.
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
(grep for callers). Epic-scale changes usually span subsystems — **spawn
multiple `Explore` subagents in parallel**, one per subsystem or angle (e.g.
backend data model, API surface, frontend consumers, test conventions), in a
single message so they run concurrently and the file dumps stay out of your
context; you keep only the conclusions. Go inline only when the change is
narrow enough that one focused grep/read pass covers it. Never skip
research — it is what makes validation criteria observable rather than
hand-wavy, and it feeds the story diff estimates in Phase 3.

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
- **Size stories to a review budget.** Each story becomes its own PR in a
  review stack (Phase 7), so estimate its diff from the research (files
  touched × expected churn) and target **~300-400 changed lines** per story,
  keeping the eventual PR under ~500. A story projecting past the budget
  gets split into sequenced stories along coherent seams — do this yourself
  during grooming; never make the user specify the split.
- Within a story, task order is the creation order; `loom order` preserves it.
  Add intra-story dep edges only for genuine prerequisites, not to encode
  sequence.

**Present the draft as an ordinary plain-text message, end your turn, and wait
for the user's typed reply.** Never use AskUserQuestion for draft approval —
the question UI hides the very plan being approved. Iterate until approved.

## Phase 4 — Materialize (gate 2)

Write `plan.json` with all items **nested** inline (bodies as JSON strings —
no per-item temp body files), then run `loom apply` once to create everything:

```bash
# Write the plan — epic at root, stories nested as children, tasks under each story.
# parent = existing project qid on the root item; no parent on nested children.
cat > plan.json <<'EOF'
{
  "items": [
    {
      "ref": "epic", "type": "epic", "parent": "<project-qid>",
      "title": "…", "body": "## Summary\n…\n\n## Validation Criteria\n…",
      "assignee": "${CLAUDE_SESSION_ID}",
      "children": [
        {
          "ref": "s1", "type": "story",
          "title": "…", "body": "…", "assignee": "${CLAUDE_SESSION_ID}",
          "children": [
            { "type": "task", "title": "…" }
          ]
        },
        {
          "ref": "s2", "type": "story",
          "title": "…", "body": "…", "assignee": "${CLAUDE_SESSION_ID}",
          "children": [
            { "type": "task", "title": "…" }
          ]
        }
      ]
    }
  ]
}
EOF

# Create all items in one call; capture the ref→qid mapping.
PLAN_OUT=$(loom apply plan.json)

# On validation failure stdout is {"errors": [...]} — fix all errors in one
# editing pass and re-apply. Each error carries path/code/message.

# Extract real qids from the mapping using the refs.
EPIC=$(echo "$PLAN_OUT" | jq -r '.created[] | select(.ref=="epic") | .qid')
S1=$(echo "$PLAN_OUT"   | jq -r '.created[] | select(.ref=="s1")   | .qid')
S2=$(echo "$PLAN_OUT"   | jq -r '.created[] | select(.ref=="s2")   | .qid')

# Wire story deps from the real qids.
loom dep apply - <<EOF
{"deps": [{"source": "$S2", "on": "$S1"}]}
EOF
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
     `git merge --no-ff <branch> -m "Merge story <qid>"` (this message
     format is load-bearing: Phase 7 locates the PR-stack cut points from
     these merge commits). Resolve only
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

**`finalize=merge`** (only if validation passed): merge the trunk and stop —
no PR stack.

```bash
git checkout <default-branch> && git merge --no-ff "loom/<SLUG>" && git push
loom complete "$EPIC"
```

**`finalize=pr`** (default): the epic ships as a **stack of PRs, one per
story**, so no single review exceeds ~500 lines. The cut points are the
trunk's story merge commits: `git log --first-parent --oneline "loom/<SLUG>"`
lists them, and Phase 5's `"Merge story <qid>"` messages map each sha
`m1…mN` to its story, in merge order. `m0` is the trunk's fork point:
`git merge-base <default-branch> "loom/<SLUG>"`.

Two checks before cutting anything:

- **Merge methods**: `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`.
  A **squash-only repo cannot host a stack** (each squash orphans the next
  PR's base) — fall back to a single trunk → default-branch PR and tell the
  user why.
- **Degenerate case**: one story, or a total trunk diff under ~500 lines
  (`git diff --stat <default-branch>...loom/<SLUG>`) → push the trunk, open
  a single PR, write `pr_url` everywhere, `loom complete "$EPIC"`, done.

Otherwise:

1. **Cut and push a segment branch per story** at each merge commit, in
   order. Name them `loom/<SLUG>-s<i>` — hyphen, never `loom/<SLUG>/s<i>`:
   a slash there makes the segment a directory-like ref under the trunk
   branch's name, which git rejects as a ref conflict.

   ```bash
   git branch "loom/<SLUG>-s1" <m1> && git push -u origin "loom/<SLUG>-s1"   # … through sN
   ```

2. **Overflow backstop**: check each segment's size with
   `git diff --stat <m(i-1)>..<mi>`. A segment over ~1,000 changed lines
   (2× the PR cap) gets split at its story's task-commit boundaries — task
   commits are coherent TDD units; cut extra branches on them, named
   `loom/<SLUG>-s<i>a`, `-s<i>b`, …, and push them like any segment. A
   sub-PR's diff stays clean even when the story forked from an older trunk
   state — GitHub diffs against the merge-base. Between ~500 and ~1,000
   lines ships as-is with the size noted in the PR body. Never split
   mechanically by file.

3. **Open the stack bottom-up**: PR 1 is `…-s1 → <default-branch>`; PR i is
   `…-s<i> → …-s<i-1>` (`gh pr create --base … --head …`). Each PR body
   carries: the story's `## Summary` and `## Validation Criteria` from
   `loom show <story> --json`; its stack position ("PR i of N for epic
   <qid>", counting sub-segments, with a link to the PR it builds on); and
   the review instruction — *merge bottom-up; delete each head branch after
   merging (or enable auto-delete of merged branches) so GitHub retargets
   the next PR's base automatically*. Note in PR 1's body that the stack
   wants merge-commit or rebase merges — squash-merging makes later diffs
   dirty until rebased.

4. **Epic-polish PR**: if validation fix passes left commits after `mN`
   (trunk tip ≠ `mN`), push the trunk and open one final PR
   `loom/<SLUG> → …-s<N>` titled as epic polish.

5. The **epic-level validation disclosure** (open criteria, fixes applied)
   goes on the last PR of the stack — the polish PR if one exists, PR N
   otherwise — where the epic is whole.

6. **Write back, complete, clean up**:

   ```bash
   loom update <story> pr_url "<that story's PR url>"   # its first sub-PR when split
   loom update "$EPIC" pr_url "<PR 1 url>"              # the stack's entry point
   loom complete "$EPIC"
   ```

   Remove the trunk worktree; segment branches disappear as their PRs
   merge.

Final message, in order: what shipped (per story), validation outcome —
stated plainly first if anything failed, with fixes applied and open criteria
verbatim — anything you hand-finished outside an executor, the PR stack in
review order with sizes, and `loom tree "$EPIC"` so the user sees the
recorded state.

## Recovery

- Session died mid-run? Everything needed to resume is in loom and git:
  find the epic via `loom tree` (the `in_progress` epic assigned to the dead
  session), re-derive finalize from the original request (absent that, `pr`),
  and re-assign the epic to the new session id. Story worktrees/branches are
  deterministic from qids and executors resume in place. Loom state implies
  the phase: open stories → Phase 5 (`loom ready` says what's next); all
  stories done, epic still open → Phase 6; epic validated but the PR stack
  absent or partial → Phase 7, which is safely re-runnable: cut points
  re-derive from the trunk's first-parent merge log, segment branch names
  are deterministic, and `gh pr list` shows which PRs already exist.
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
