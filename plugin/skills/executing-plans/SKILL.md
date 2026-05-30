---
name: executing-plans
description: "Use after writing-plans has materialized loom items. Orchestrates execution end-to-end: epic-wave loop (parallel story-executor dispatch + per-story merge & validate) for epic scope, or single-executor-then-integrator for story scope; on validation success, finalizes the branch (opens a PR by default; merges into main and pushes only when the user explicitly requested it)."
---

# Executing Plans — loom-backed orchestrator

<SUBAGENT-STOP>
If you were dispatched as a subagent (story-executor, story-integrator,
epic-validator, codebase-researcher, or any other agent type), STOP — this
skill is not yours. It is the orchestrator's, and only the main session
runs it. Subagents that invoke this skill will create nested orchestration
loops, mis-write the parent session's worktree state, and corrupt the
epic-wave invariants. Return to your dispatched task instructions instead.
</SUBAGENT-STOP>

This skill is the orchestrator. It runs in the main session (not a subagent) and dispatches the per-story / per-task work.

**Announce at start:** "I'm using the executing-plans skill to orchestrate execution."

<HARD-GATE name="anti-fabrication">
## Anti-Fabrication Gate — NEVER Invent Tool Output

The orchestrator MUST NEVER narrate or act on a result it has not actually
received from a real tool call. This includes but is not limited to:

- Branch names (e.g. `worktree-<random>`)
- Commit SHAs
- Test counts or pass/fail summaries
- PR URLs
- Any executor result JSON field

**When tool output is missing, delayed, empty, or ambiguous: STOP and wait.**
Do NOT guess, infer, or fabricate any field. Do NOT proceed with downstream
steps (dispatching integrators, calling `loom complete`, finalizing) based
on narrated or assumed values.

Every concrete value the orchestrator forwards to another agent or uses in
a command MUST be a verbatim copy of real text from a real tool result in
the current session. If you cannot point to the exact tool-result turn that
produced a value, you do not have it — halt and surface the gap to the user.
</HARD-GATE>

## What you receive

From the writing-plans skill's handoff, one of:
- `epic_qid=<qid>` — runs the epic wave loop
- `story_qid=<qid>` — runs the single-story shape

Plus the bound loom project qid and `${CLAUDE_SESSION_ID}` (for orchestrator-side ownership tracking if needed).

## Orchestrator state files

Maintained under `<epic-worktree>/.loom/`:
- `retry-counters.json` — per-story retry counts across waves

This file is gitignored by loom's `.loom/.gitignore`.

## Semantic event logging

The orchestrator emits semantic events via `"${CLAUDE_PLUGIN_ROOT}/scripts/loom-log-event.sh"` at key decision points — moments the mechanical hooks (SubagentStart, TaskUpdate, etc.) cannot observe. These are wave composition, retry rationale, validation outcome interpretation, and the finalize decision. Mechanical events (agent lifecycle, task transitions, commits) are handled automatically; do not re-emit them.

Base invocation pattern:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/loom-log-event.sh" \
  --kind <semantic_kind> \
  --epic-qid <epic_qid> \
  --agent-id "${CLAUDE_SESSION_ID}-orchestrator" \
  --session-id "$CLAUDE_SESSION_ID" \
  --agent-type "story-executor" \
  [--story-qid <sqid>] \
  [--field key=value] ...
```

See `docs/orchestrator-log.md` for the full semantic event vocabulary and per-kind payload spec.

## Epic wave loop

### Setup (once per `/epic`)

1. **Ensure `main` is up to date before creating the epic worktree.** The
   epic worktree branches off the orchestrator's current HEAD, so `main`
   must be checked out and fast-forwarded to `origin/main` first. A
   diverged or stale `main` would poison every story-executor worktree
   branching from it.

   ```bash
   git checkout main && git fetch origin && git pull --ff-only origin main
   ```

   If `git pull --ff-only` fails (local `main` has diverged from
   `origin/main`), **halt immediately** and surface the divergence to the
   user. Do not proceed with worktree creation until the user resolves the
   conflict.

2. Call `EnterWorktree` with `name="loom/<epic-qid-dashed>"` to enter a
   worktree for the epic. The harness creates the worktree at
   `<repo>/.claude/worktrees/<name-with-slashes-replaced>/` on a branch
   named `worktree-<name>` (the renamed-slash form), off the parent
   session's HEAD (typically `main`).
3. Confirm the working directory is the epic worktree (the harness sets
   cwd as part of `EnterWorktree`) and record:
   - `<epic_worktree>` — the absolute path printed by `pwd`.
   - `<epic_branch>` — the branch name from `git rev-parse --abbrev-ref HEAD`.

   You will pass both to story-integrator dispatches.
4. Initialize retry counters file: `mkdir -p .loom && echo "{}" > .loom/retry-counters.json`.

### How subagents create their own worktrees

Story-executor agents are declared with `isolation: worktree` in their
frontmatter. The Claude Code harness automatically creates a per-subagent
worktree on dispatch — you do NOT pass an `isolation` parameter or specify
a worktree path. The base branch is governed by the `worktree.baseRef`
setting (must be `"head"` in `~/.claude/settings.json` so subagents branch
off the orchestrator's current HEAD, i.e. the epic branch).

The harness names the auto-worktree's branch `worktree-<random>` and
places it at `<repo>/.claude/worktrees/<random>/`. The executor records
both and reports them back in its result JSON as `branch` and `worktree`.
You forward those exact values to the story-integrator — do NOT construct
branch names from the story qid.

### Loop body (until no ready stories remain)

```
loop:
    ready=$(loom ready <epic-qid> --type story --json)
    if [empty]: break

    # Wave N: dispatch story-executor subagents in PARALLEL
    # Log wave composition before dispatch — the orchestrator knows which stories
    # are in the wave; mechanical hooks only see individual subagent starts.
    "${CLAUDE_PLUGIN_ROOT}/scripts/loom-log-event.sh" \
      --kind wave_start \
      --epic-qid <epic_qid> \
      --agent-id "${CLAUDE_SESSION_ID}-orchestrator" \
      --session-id "$CLAUDE_SESSION_ID" \
      --agent-type "story-executor" \
      --field "wave_index=<N>" \
      --field "story_qids=<sqid1> <sqid2> ..."

    for each sqid in ready:
        - Dispatch:
            Agent(subagent_type="story-executor",
                  prompt="story_qid=<sqid> parent_branch=<epic_branch>")
          # Prompt is exactly two fields — see "Dispatch prompt contract" section.
          # Do NOT add the epic body, sibling-story bodies, or other context.
          # The harness creates the executor's worktree automatically via
          # the agent's `isolation: worktree` frontmatter. The executor
          # records its assigned branch + worktree path and returns them
          # in its result JSON.
    wait for ALL parallel dispatches to complete

    # Extract from each executor's return value the fields you need to
    # dispatch the integrator. Each executor returns JSON of shape:
    #   {"story_qid": "...", "branch": "worktree-<random>",
    #    "worktree": "<repo>/.claude/worktrees/<random>/", "commits": [...],
    #    "tasks_done": [...], "notes": "..."}
    # Store per-sqid: executor_branch[sqid], executor_worktree[sqid].

    # <HARD-GATE name="branch-worktree-verification">
    # BEFORE dispatching any integrator, verify that the branch and worktree
    # from the executor result actually exist on disk. Run these commands and
    # check the output — do NOT skip or assume:
    #
    #   git rev-parse --verify <executor_branch[sqid]>
    #   git worktree list | grep <executor_worktree[sqid]>
    #
    # If either command fails or returns no match:
    #   - Do NOT dispatch the integrator with unverified values.
    #   - Re-derive or reconstruct only if you have a deterministic basis
    #     (e.g. from git worktree list output). If you cannot re-derive with
    #     certainty, HALT and surface the mismatch to the user.
    # </HARD-GATE>

    # Log wave completion with a brief outcome summary.
    "${CLAUDE_PLUGIN_ROOT}/scripts/loom-log-event.sh" \
      --kind wave_complete \
      --epic-qid <epic_qid> \
      --agent-id "${CLAUDE_SESSION_ID}-orchestrator" \
      --session-id "$CLAUDE_SESSION_ID" \
      --agent-type "story-executor" \
      --field "wave_index=<N>" \
      --note "<M ok, K failed>"

    # Integrate each completed story sequentially
    for each sqid that the executor reported done (topo order):
        result = Agent(subagent_type="story-integrator",
                       prompt="epic_qid=<epic-qid> story_qid=<sqid> "
                              "branch=<executor_branch[sqid]> "
                              "parent_branch=<epic_branch> "
                              "epic_worktree=<epic_worktree> "
                              "story_worktree=<executor_worktree[sqid]>")
        if result.result == "ok":
            loom complete <sqid>
        elif result.result in ("merge_failed", "validation_failed"):
            # Discard the story; it goes back to ready and gets picked up next iteration.
            git -C <epic_worktree> worktree remove --force <executor_worktree[sqid]>
            git -C <epic_worktree> branch -D <executor_branch[sqid]>
            loom reopen <sqid>
            increment retry_counter[sqid] in .loom/retry-counters.json
            if retry_counter[sqid] >= 3:
                HALT with diagnostic — surface result.reason / failed_criteria to the user
            # Log the retry decision so the audit trail captures the rationale.
            "${CLAUDE_PLUGIN_ROOT}/scripts/loom-log-event.sh" \
              --kind retry_decision \
              --epic-qid <epic_qid> \
              --agent-id "${CLAUDE_SESSION_ID}-orchestrator" \
              --session-id "$CLAUDE_SESSION_ID" \
              --agent-type "story-executor" \
              --story-qid <sqid> \
              --field "attempt=<retry_counter[sqid]>" \
              --field "reason=<result.result>: <brief description>"
```

To dispatch subagents in parallel, send a single message with multiple `Agent` tool calls.

### After loop exits

1. Dispatch the final validator:
   ```
   Agent(subagent_type="epic-validator",
         prompt="epic_qid=<eqid> branch=loom/<eqid> worktree=<epic-worktree>")
   ```
2. If `result.result == "ok"`:
   - `loom complete <epic-qid>`
   - Proceed to the **Finalize branch** section below to open a PR (or merge+push if explicitly requested).
3. Else: HALT with the validator's diagnostic. Do not auto-retry at the epic level — that's a human decision.

## Story (single-item) shape

For `story_qid=...` entry:

1. **Ensure `main` is up to date before dispatching the story-executor.**
   The harness creates the executor's worktree off the orchestrator's
   current HEAD (`worktree.baseRef=head`), so if the orchestrator is not
   on an up-to-date `main`, the executor branches off a stale or diverged
   base. Check out `main` and fast-forward it before proceeding:

   ```bash
   git checkout main && git fetch origin && git pull --ff-only origin main
   ```

   If `git pull --ff-only` fails (local `main` has diverged from
   `origin/main`), **halt immediately** and surface the divergence to the
   user. Do not dispatch the story-executor until the user resolves the
   conflict.

2. Dispatch one story-executor:
   ```
   Agent(subagent_type="story-executor",
         prompt="story_qid=<sqid> parent_branch=main")
   ```
   Prompt is exactly two fields — see "Dispatch prompt contract" section.
   Do NOT add the story body, epic body, or any extra context.
   The harness creates the executor's worktree automatically (`isolation:
   worktree` frontmatter). The executor returns `branch` and `worktree` in
   its result JSON. Capture both.

   **Branch/worktree verification (HARD-GATE):** Before dispatching the
   integrator, verify the executor-reported branch and worktree exist:
   ```bash
   git rev-parse --verify <executor_branch>
   git worktree list | grep <executor_worktree>
   ```
   If either check fails: do NOT dispatch the integrator. Re-derive from
   `git worktree list` if possible; otherwise HALT and surface to the user.

3. Wait. Then dispatch a story-integrator with `epic_qid=none` (the integrator will skip the merge step and run validation directly on the story branch):
   ```
   Agent(subagent_type="story-integrator",
         prompt="epic_qid=none story_qid=<sqid> "
                "branch=<executor_branch> "
                "parent_branch=main "
                "epic_worktree=<repo-root> "
                "story_worktree=<executor_worktree>")
   ```
4. If `result.ok`:
   - `loom complete <sqid>`
   - Proceed to the **Finalize branch** section below to open a PR (or merge+push if explicitly requested).
5. If `result` is merge_failed or validation_failed:
   - `loom reopen <sqid>`, increment retry counter, redispatch up to 3 times.
   - On exhausting retries: HALT.

## Tracking work in the orchestrator's own Task List

In your own (main session) Task List, use subjects formatted as `[<sqid>] <story title>` while a wave is in flight. When the story executor completes, call `loom complete <sqid>` to mark the story done in loom.

## Finalize branch

On final validation success, this skill itself terminates the flow by integrating the validated branch into its parent. There is no further handoff.

**What "the branch" means here:**
- For epic flow: the epic branch `loom/<epic-qid>` is integrated into `main` (via PR or merge).
- For story flow (`/story`): the story branch `loom/<sqid>` is integrated into `main` (via PR or merge).

In the default PR path, the branch and worktree are left in place for the user to land. In the merge + push path, cleanup (branch delete + worktree remove) happens after a successful push.

**Default behavior (open a PR):**

Push the branch and open a PR. Emit `epic_finalize` with a `pr_url` once the PR is created:

```bash
git push -u origin <branch>
pr_url=$(gh pr create --base <parent> --head <branch> \
  --title "<epic or story title>" \
  --body "<summary derived from the loom item body>")

"${CLAUDE_PLUGIN_ROOT}/scripts/loom-log-event.sh" \
  --kind epic_finalize \
  --epic-qid <epic_qid> \
  --agent-id "${CLAUDE_SESSION_ID}-orchestrator" \
  --session-id "$CLAUDE_SESSION_ID" \
  --agent-type "story-executor" \
  --field "merged_to=<parent>" \
  --field "pr_url=${pr_url}"
```

Leave the branch and worktree in place; the user will land the PR.

**Merge + push (only when explicitly requested):**

If the original `/epic` or `/story` request contains explicit merge-to-main wording (e.g. "merge to main", "push to main", "no PR"), merge locally and push instead of opening a PR.

Before merging, emit an `epic_finalize` event so the log captures the finalize decision:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/loom-log-event.sh" \
  --kind epic_finalize \
  --epic-qid <epic_qid> \
  --agent-id "${CLAUDE_SESSION_ID}-orchestrator" \
  --session-id "$CLAUDE_SESSION_ID" \
  --agent-type "story-executor" \
  --field "merged_to=<parent>"
```

Then merge and push:
```bash
cd <repo-root>          # use the main checkout, not the worktree
git fetch origin
git checkout <parent>   # main for epics, main for /story flow
git pull --ff-only
git merge --no-ff <branch> -m "Merge <branch>: <one-line summary>"
git push origin <parent>
```

Use `--no-ff` to preserve the branch boundary in history, matching the convention the story-integrator already uses for per-story merges into the epic branch.

After a successful push, clean up the local branch and worktree:

```bash
git branch -d <branch>
git worktree remove <worktree-path>   # if a worktree existed for this branch
```

**How to tell which mode applies.** PR creation is the default. Use merge + push only when the original `/epic` or `/story` request contains explicit merge-to-main wording (e.g. "merge to main", "push to main", "no PR"). If genuinely ambiguous, ask once before acting.

**Validation failure path is unchanged:** if the final validator returned a failure, halt and surface the diagnostic — do not attempt to finalize.

## Halt UX

When you halt, leave the workspace inspectable:
- Branches stay in place
- Worktrees stay in place (the failed-story worktree was deleted; others remain)
- Loom items reflect current status
- The per-agent JSONL logs under `${XDG_STATE_HOME:-$HOME/.local/state}/loom/<project>/<epic_qid>/` have the full event trail; merge and sort by `ts` to reconstruct the timeline (see `docs/orchestrator-log.md`)
- `.loom/retry-counters.json` shows what's been retried

Tell the user where things stand and suggest concrete next steps (e.g., "Run `cd <epic-worktree> && loom tree <epic-qid>` to inspect; the failing story is `<sqid>` with these unmet criteria: ...").

## Dispatch prompt contract

When dispatching a story-executor subagent, the `prompt` field MUST contain
exactly two fields and nothing more:

```
story_qid=<sqid> parent_branch=<branch>
```

**Do NOT include** any of the following in the dispatch prompt:
- The epic body (or any part of it)
- Sibling-story bodies (bodies of other stories in the same wave or epic)
- Validation criteria of other stories
- Any inlined context, background, or prose from loom items

The story-executor fetches its own story body via `loom show <story_qid>` inside
the subagent. It does not need — and must not receive — context that belongs to
other items. Inlining such context creates cross-story contamination and
violates the isolation guarantees of the worktree-per-executor model.

## Constraints

- **Never open a PR or push before final validation passes.** PR-opening / pushing happens only in the Finalize branch section, after the final validator returns `ok`.
- **Never call `loom complete` on a story before the integrator returns `ok`.**
- **Never auto-retry at the epic level.** Halt and surface.
- **Bounded retries**: 3 per story across waves.

<HARD-GATE name="loom-complete-and-finalize">
## loom complete + Finalize Gates

### loom complete <sqid>

`loom complete <sqid>` MAY run ONLY when:
1. The story-integrator subagent has returned a real tool result (visible in
   this session's tool-use history) with `result: ok`.
2. That `result: ok` appears in an actual tool-result turn — not narrated,
   not inferred, not assumed from a delayed or missing response.

Do NOT call `loom complete <sqid>` based on anything other than a verbatim
`result: ok` in a real tool result from that story's integrator.

### Finalizing (PR or merge)

Before finalizing (pushing the branch and opening a PR, or merging), the
orchestrator MUST independently re-verify every epic Validation Criterion
by running real commands and confirming their real output. Steps:

1. Read the story or epic body (`loom show <qid> --json`) and extract every
   bullet under `## Validation Criteria`.
2. For each criterion, run the verification command(s) and capture the actual
   output in this session. Do NOT assume a criterion passes based on what an
   executor or integrator reported — re-run it.
3. Proceed to finalize only if ALL criteria are confirmed by real command
   output. If any criterion fails or cannot be verified, HALT and surface
   the gap to the user.
</HARD-GATE>
