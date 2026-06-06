---
name: writing-plans
description: "Use after the brainstorming skill produces an approved groomed draft. Materializes the draft as loom items via `loom epic|story|task create --body-file`, adds dependencies via `loom dep add`, sets `assignee` on epics and stories. Hands off by launching the appropriate workflow (epic or story)."
---

# Writing Plans — loom-backed materialization

This skill takes an approved groomed draft from `brainstorming` and turns it
into a tree of loom items. It is the only writer of loom items in the
workflow.

**Announce at start:** "I'm using the writing-plans skill to materialize the plan in loom."

## What you receive

From the brainstorming skill's handoff:
- The approved groomed draft (titles, bodies, child items, deps)
- The scope: `mode=epic` or `mode=story`
- The bound loom project qid
- `${CLAUDE_SESSION_ID}` — for the `assignee` field

## Body template (enforced)

Every created epic and story body MUST contain these sections in order:

```markdown
## Summary
<one-paragraph statement of what this delivers>

## Context
<what the code looks like today; pointers to files/symbols the agent will touch>

## Validation Criteria
- [ ] <observable criterion 1>
- [ ] <observable criterion 2>
- [ ] <...>

## Implementation Notes
<for stories: any non-obvious approach decisions made during grooming>
<for epics: the story breakdown rationale, cross-story interactions>

## Out of Scope
<things explicitly NOT in this item; common source of validation disputes>
```

Tasks do NOT carry validation criteria; their bodies are short (under ~10 lines), describing what the single task does. Each task must be scoped to a single line or single-function change — no task should bundle multiple independent edits.

## Workflow

> Before running any loom CLI command, invoke `loom:using-loom-cli` to ensure the correct global flags and workspace are in scope.

### Step 1: Compose body files

In a temp directory (`mktemp -d`), write one markdown file per loom item to be created. Name them descriptively (e.g., `epic.md`, `story-1.md`, `task-1-1.md`).

### Step 2: Create the loom items

For **epic mode**:

```bash
EPIC=$(loom epic create <project-qid> --title "<title>" --body-file <tmp>/epic.md)
loom update "$EPIC" assignee "${CLAUDE_SESSION_ID}"

for each story in the draft:
  STORY=$(loom story create "$EPIC" --title "<story title>" --body-file <tmp>/story-N.md)
  loom update "$STORY" assignee "${CLAUDE_SESSION_ID}"
  # Every story MUST have at least one task — a story with no tasks cannot be executed.
  for each task in the story:
    loom task create "$STORY" --title "<task title>" --body-file <tmp>/task-N-M.md
```

For **story mode**:

```bash
# Story lives under <project>:backlog
STORY=$(loom story create "<project>:backlog" --title "<title>" --body-file <tmp>/story.md)
loom update "$STORY" assignee "${CLAUDE_SESSION_ID}"
# Every story MUST have at least one task — a story with no tasks cannot be executed.
for each task in the draft:
  loom task create "$STORY" --title "<task title>" --body-file <tmp>/task-N.md
```

### Step 3: Add dependencies

```bash
loom dep add <source-qid> --on <target-qid>
```

Loom rejects cycles automatically (exit code 4). If you hit a cycle, the groom phase produced a malformed plan — surface the cycle to the user and stop.

### Step 4: Self-review

```bash
loom validate
loom tree <epic-qid or story-qid>
```

Show both outputs to the user. Confirm the structure is what they approved. If they want changes:
- Status / structure: `loom update`, `loom dep add/rm`, etc.
- Bodies: `loom update <qid> body --body-file <new-file>`

### Step 5: Hand off

Once the user signs off on the materialized tree, invoke `loom:writing-workflows`
with the root qid and finalize flag. That skill generates a bespoke baked-DAG
workflow script and launches it.

**Epic mode:** pass `mode=epic`, `epic_qid=<qid>`, `finalize=<'pr' or 'merge'>`.

**Story mode:** pass `mode=story`, `story_qid=<qid>`, `finalize=<'pr' or 'merge'>`.

`finalize` defaults to `"pr"` (opens a pull request). Set it to `"merge"` only
when the original request explicitly asked to merge to main (e.g. "merge to main",
"push to main", "no PR"). The generated workflow handles worktree creation,
execution, validation, and finalization.

## Constraints

- **Always use `--body-file`.** Never use `--body` with multi-paragraph strings — temp files keep the loom CLI invocation clean and atomic.
- **Always set `assignee` on epics and stories at creation.** Tasks never carry assignee.
- **Never write a markdown plan file.** Loom items are the only plan artifact.
- **One item per create call.** Don't try to batch via shell loops without checking exit codes — capture each created qid for later reference.

## No placeholders in loom item bodies

The body template is mandatory. Don't leave "TBD" or "Add criteria later" in Validation Criteria sections — the brainstorming step produced concrete criteria. If the criteria are vague, return to brainstorming.

## Every story must decompose into ordered granular tasks

Every story MUST have at least one task. A story with no tasks cannot be executed — the story-executor agent relies on `loom order` to drive its work loop, and an empty task list causes it to stop and report a malformed plan.

Tasks must be:
- **Granular**: each task is scoped to a single line or single-function change. If a task bundles multiple independent edits, split it.
- **Ordered**: the task list is sequenced as a step-by-step manual for completing the story — dependencies are declared so `loom order` produces a coherent execution sequence.

Granular ordered tasks make execution and validation tractable. Without them a story executor cannot make reliable incremental progress, cannot produce atomic commits, and cannot verify partial work against criteria. If the groomed draft delivered by brainstorming has no tasks or only coarse tasks, return to brainstorming before materializing.
