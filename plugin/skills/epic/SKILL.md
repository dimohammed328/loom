---
name: epic
description: "Use when the user types /epic followed by a description of a large feature, refactor, or end-to-end change. Drives the full loom-backed planning and parallel execution workflow: research → groom → plan as a loom epic with child stories and tasks → execute via parallel story-subagents with merge and validation orchestration → final epic-level verify → finalize the branch (opens a PR by default; merges into main and pushes only when the user explicitly requested it)."
---

# /epic — Large-feature workflow

The user has invoked `/epic <description>`. The description is in `$ARGUMENTS`. Session id is `${CLAUDE_SESSION_ID}`.

## Mandatory sequence

1. **Bind loom** to this repo:
   - Walk up from cwd for `.loom/state.json`. If found, note the bound project qid.
   - If not found, run `loom -y project create <repo-basename>` (loom auto-discovers the `origin` remote). Fail if cwd is not in a git repo.

2. **Hand off to `loom:brainstorming`** with context:
   - `mode=epic`
   - `description=$ARGUMENTS`
   - `project=<project-qid>`
   - `session_id=${CLAUDE_SESSION_ID}`

3. brainstorming returns a groomed draft (epic title, body with criteria, list of stories with their drafts, story deps).

4. **Hand off to `loom:writing-plans`** with the groomed draft. That skill materializes the epic, stories, tasks, and deps in loom via CLI; sets `assignee: ${CLAUDE_SESSION_ID}` on the epic and stories; writes bodies via `--body-file`.

5. **Launch the epic workflow** by invoking:
   ```js
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/epic.workflow.js",
     args: { epic_qid: "<qid>", finalize: "<'pr' or 'merge'>" }
   })
   ```
   Set `finalize` to `"merge"` only if the original `/epic` request explicitly asked to merge to main (e.g. "merge to main", "push to main", "no PR"); otherwise use `"pr"` (the default). The workflow creates the epic worktree, runs the story scheduler loop, runs final epic validation, and finalizes the branch. On failure, the workflow halts and surfaces the diagnostic — that ends your turn.

## Constraints

- Never skip the groom phase even if the description is detailed — the research step always adds value.
- Never execute code changes from this skill directly. All implementation happens inside story-executor subagents in story worktrees.
- If the workflow halts at any step (cycle detected during planning, validation fails after retries, merge conflict requires human input), surface the diagnostic and stop. Do not retry or work around silently.

## What you do NOT do here

- Do NOT dispatch subagents directly. Each skill in the chain knows its part.
- Do NOT write to loom directly. `writing-plans` handles all loom writes during planning; the workflow handles writes during execution.
- Do NOT create worktrees or branches yourself — the workflow and the story-executor handle them.
