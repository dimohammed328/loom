---
name: writing-workflows
description: "Use after loom:writing-plans finalizes a loom epic or story — generates a bespoke, baked-DAG workflow script with story ordering baked as literal data, replacing the static scriptPath launch."
---

# Writing Workflows

## Scope & handoff

This skill is invoked by `loom:writing-plans` **after** loom items are created
and qids captured. It replaces the static `Workflow({ scriptPath })` launch that
previously referenced `plugin/workflows/epic-runner.workflow.js` or
`story-runner.workflow.js`.

**Modes:**

| Mode | Trigger | What you receive |
|------|---------|-----------------|
| **epic** | epic groomed in loom | `epic_qid`, `finalize` (`"pr"` or `"merge"`), project qid |
| **story** | story groomed in loom | `story_qid`, `finalize` (`"pr"` or `"merge"`), project qid |

**Handoff source:** `loom:writing-plans` calls this skill after Step 4
(self-review) passes. At that point all loom items exist, `loom tree` is clean,
and the caller hands you the root qid + finalize flag.

**Handoff output:** A generated `.js` workflow file at
`.loom/workflows/<slug>.workflow.js` and a `Workflow({ scriptPath: "<abs path>",
args: {} })` call that launches it.

## Canonical workflow steps

A generated epic workflow follows these phases in order. A story workflow skips
phases that don't apply (no trunk setup, no epic-level validation).

1. **Trunk setup** *(epic only)* — create the epic's shared branch, push to
   remote.
2. **Story convergence loop** — for each story in DAG-dependency order (deps
   first):
   a. Dispatch a `story-executor` subagent (branch forked from trunk).
   b. Wait for the story-executor to return `branch` + `worktree`.
   c. Merge the story branch into trunk; clean up the worktree.
   d. Mark the story done in loom via `loom complete <story_qid>`.
   e. Record the story in the `merged` set; unblock downstream stories.
3. **Inter-story validation** *(epic only)* — after all stories merge, run the
   epic-level validation criteria against trunk.
4. **Finalize** — open a PR (`finalize="pr"`) or merge into main and push
   (`finalize="merge"`).

A story workflow (single story) is equivalent to steps 2a–2b + step 4.

## Loom invariants to instill

Every generated workflow **must** respect these invariants. They are
non-negotiable; violating them produces a workflow that diverges from the loom
data model.

### Only `done` satisfies a dependency

The baked-DAG scheduler releases a story for dispatch when every qid listed in
`deps` appears in the `merged` set. The `merged` set is populated only when a
story branch is successfully merged and `loom complete` is called. Custom
statuses (e.g. `completed`, `in_progress`) do **not** satisfy a dependency —
only the literal `done` status written by `loom complete` does.

### DAG order derives from inter-story deps

The `STORIES` literal encodes the topological order as explicit `deps` arrays
(not a flat sequence). The scheduler must respect this structure — do not
sort stories alphabetically or by creation order. The dependency graph produced
during loom planning is authoritative.

### Status writes via `loom complete`

The workflow is the only agent that calls `loom complete <story_qid>` on a
story. Individual story-executor subagents call `loom complete` only on their
own tasks. The orchestrating workflow owns story-level status.

### `-y` is a GLOBAL flag on the `loom` command

In any `loom` CLI invocation inside a generated workflow, `-y` /
`--non-interactive` must appear **immediately after `loom`**, before the
subcommand:

```bash
# Correct
loom -y complete loom-app:abc123:1

# WRONG — will error
loom complete -y loom-app:abc123:1
```

