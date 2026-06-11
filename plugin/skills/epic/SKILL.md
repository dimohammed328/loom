---
name: epic
description: "Use when the user types /epic followed by a description of a large feature, refactor, or end-to-end change. Drives the full loom-backed planning and parallel execution workflow: research → groom → plan as a loom epic with child stories and tasks → execute via parallel story-subagents with merge and validation orchestration → final epic-level verify → finalize the branch (opens a PR by default; merges into main and pushes only when the user explicitly requested it)."
---

# /epic — Large-feature workflow

The user has invoked `/epic <description>`. The description is in `$ARGUMENTS`. Session id is `${CLAUDE_SESSION_ID}`.

## Mandatory sequence

1. **Bind loom** to this repo:
   - Run `loom status --json` and read `.project` for the bound project qid.
   - If it exits non-zero (no workspace bound), run `loom -y project create <repo-basename>` (loom auto-discovers the `origin` remote), then re-run `loom status --json`. Fail if cwd is not in a git repo.

2. **Hand off to `loom:brainstorming`** with context:
   - `mode=epic`
   - `description=$ARGUMENTS`
   - `project=<project-qid>`
   - `session_id=${CLAUDE_SESSION_ID}`

3. brainstorming returns a groomed draft (epic title, body with criteria, list of stories with their drafts, story deps).

4. **Hand off to `loom:writing-plans`** with the groomed draft. That skill materializes the epic, stories, tasks, and deps in loom via CLI; sets `assignee: ${CLAUDE_SESSION_ID}` on the epic and stories; writes bodies via `--body-file`.

5. **Hand off to `loom:writing-workflows`** by invoking:
   ```
   loom:writing-workflows mode=epic epic_qid=<qid> finalize=<'pr' or 'merge'>
   ```
   `finalize` is derived mechanically from the original `/epic` request text — it is NEVER a question for the user. Use `"merge"` only when the request explicitly asked to merge (e.g. "merge to main", "push to main", "no PR"); in every other case — including when the request says nothing about merging — use `"pr"`. Do NOT ask the user to choose between PR and merge, in prose or via AskUserQuestion. Unsure means `"pr"`. That skill generates a bespoke baked-DAG workflow script and launches it. The generated workflow creates the epic worktree, runs the story scheduler loop, runs final epic validation, and finalizes the branch. On any non-ok result, follow the **HALT PROTOCOL** below.

## HALT PROTOCOL — BINDING

> **EXTREMELY IMPORTANT.** When the workflow launched in step 5 returns a
> result that is not `ok` (validation failed, merge conflict, cycle detected,
> finalize error, or any other non-success outcome), the ONLY permitted
> responses are:
>
> 1. Report the returned `reason`, validation criteria, and any open findings
>    to the user **verbatim**, exactly as the workflow surfaced them.
> 2. Offer to re-run or resume the workflow (the epic worktree and all story
>    worktrees are reused; fix-tasks resume where validation left off).
> 3. Route any real code or doc fix through a **new `/story`** or a
>    **story-fixer re-dispatch** against the existing story worktree.
>
> **NEVER do any of the following after a non-ok result:**
>
> - Edit, Write, or commit files in the trunk, the epic worktree, or any
>   story worktree directly from this skill.
> - Run ad-hoc smoke or verify scripts to manually clear the finalize gate.
> - Hand-run `gh pr create`, `git merge`, or `loom complete` to bypass the
>   workflow.
>
> **Post-completion follow-ups are a new `/story`, never a hand-edit on the
> epic branch.**

## Constraints

- Never skip the groom phase even if the description is detailed — the research step always adds value.
- Never execute code changes from this skill directly. All implementation happens inside story-executor subagents in story worktrees.

## What you do NOT do here

- Do NOT dispatch subagents directly. Each skill in the chain knows its part.
- Do NOT write to loom directly. `writing-plans` handles all loom writes during planning; the workflow handles writes during execution.
- Do NOT create worktrees or branches yourself — the workflow and the story-executor handle them.
