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

6. **Hand off to `loom:writing-workflows`** by invoking:
   ```
   loom:writing-workflows mode=story story_qid=<qid> finalize=<'pr' or 'merge'>
   ```
   Set `finalize` to `"merge"` only if the original `/story` request explicitly asked to merge to main (e.g. "merge to main", "push to main", "no PR"); otherwise use `"pr"` (the default). That skill generates a bespoke baked-DAG workflow script and launches it. The generated workflow dispatches one story-executor, runs review and validation, and finalizes the branch. On validation fail after 3 retries, the workflow halts and surfaces the diagnostic.

## HALT PROTOCOL — BINDING

> **EXTREMELY IMPORTANT.** When the workflow launched in step 6 returns a
> result that is not `ok` (validation failed, merge conflict, finalize error,
> or any other non-success outcome), the ONLY permitted responses are:
>
> 1. Report the returned `reason`, validation criteria, and any open findings
>    to the user **verbatim**, exactly as the workflow surfaced them.
> 2. Offer to re-run or resume the workflow (the story worktree is reused;
>    fix-tasks resume where validation left off).
> 3. Route any real code or doc fix through a **new `/story`** or a
>    **story-fixer re-dispatch** against the existing story worktree.
>
> **NEVER do any of the following after a non-ok result:**
>
> - Edit, Write, or commit files in the trunk or the story worktree directly
>   from this skill.
> - Run ad-hoc smoke or verify scripts to manually clear the finalize gate.
> - Hand-run `gh pr create`, `git merge`, or `loom complete` to bypass the
>   workflow.
>
> **Post-completion follow-ups are a new `/story`, never a hand-edit on the
> story branch.**

## Constraints

- Never skip the groom phase even if the description is detailed — the research step always adds value.
- Never execute code changes from this skill directly. All implementation happens inside the story-executor subagent in its worktree.
