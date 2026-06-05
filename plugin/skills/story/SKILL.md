---
name: story
description: "Use when the user types /story followed by a description of a small, scoped change — a bugfix, single-file refactor, or self-contained feature. Drives the loom-backed flow at story scale: research → groom → plan as a loom story (with tasks) under the project's backlog epic → execute via a single story-executor subagent → validate → finalize the branch (opens a PR by default; merges into main and pushes only when the user explicitly requested it)."
---

# /story — Small-change workflow

The user has invoked `/story <description>`. The description is in `$ARGUMENTS`. Session id is `${CLAUDE_SESSION_ID}`.

## Mandatory sequence

1. **Bind loom** to this repo: run `loom status --json` and read `.project` for the bound project qid. If it exits non-zero (no workspace bound), run `loom -y project create <repo-basename>` (loom auto-discovers the `origin` remote), then re-run. Fail if cwd is not in a git repo.

2. **Identify the target epic**: the project's default `backlog` epic (qid `<project>:backlog`). Loom auto-creates the backlog epic on every project at schema_version=2 and later; if it's missing (older project), the `loom story create` command auto-creates it on first use.

3. **Hand off to `loom:brainstorming`** with context:
   - `mode=story`
   - `description=$ARGUMENTS`
   - `epic=<project>:backlog`
   - `session_id=${CLAUDE_SESSION_ID}`

4. brainstorming returns a groomed story draft (title, body with criteria, task list).

5. **Hand off to `loom:writing-plans`** with the groomed draft. That skill creates the story under backlog and its tasks; sets `assignee: ${CLAUDE_SESSION_ID}` on the story.

6. **Launch the story workflow** by invoking:
   ```js
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/story.workflow.js",
     args: { story_qid: "<qid>", finalize: "<'pr' or 'merge'>" }
   })
   ```
   Set `finalize` to `"merge"` only if the original `/story` request explicitly asked to merge to main (e.g. "merge to main", "push to main", "no PR"); otherwise use `"pr"` (the default). The workflow dispatches one story-executor, runs review and validation, and finalizes the branch. On validation fail after 3 retries, the workflow halts and surfaces the diagnostic.

## Constraints

- Never skip the groom phase even if the description is detailed — the research step always adds value.
- Never execute code changes from this skill directly. All implementation happens inside the story-executor subagent in its worktree.
- If the workflow halts at any step (validation fails after retries, merge conflict requires human input), surface the diagnostic and stop. Do not retry or work around silently.
