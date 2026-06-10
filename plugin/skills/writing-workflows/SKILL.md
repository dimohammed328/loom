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
2. **Story convergence loop** — every story is launched as a self-contained
   async "run" (registered in a central store keyed by qid); the DAG is driven
   by data dependencies, not an explicit scheduler loop. Each run:
   a. Awaits its dependencies' outcomes from the central store (`runs.get(dep)`);
      if any dependency did not land, the run skips itself and records a failure.
   b. Dispatches a `story-executor` subagent (branch forked from trunk) and
      waits for `branch` + `worktree` — this runs concurrently with every
      independent sibling.
   c. Serializes its merge into the single shared trunk worktree through a merge
      gate (a chained promise) — prepares are parallel, merges are strictly
      one-at-a-time; cleans up the worktree.
   d. Marks the story done in loom via `loom complete <story_qid>`.
   e. Records its outcome (`{ ok: true }`) in the central store, which lets its
      dependents proceed.
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

A story's run proceeds past step (a) only when every qid listed in `deps` has
resolved to an `ok` outcome in the central store. That outcome is recorded only
when a story branch is successfully merged and `loom complete` is called. Custom
statuses (e.g. `completed`, `in_progress`) do **not** satisfy a dependency —
only the literal `done` status written by `loom complete` does.

### DAG edges live in `deps`, not array order

The `STORIES` literal encodes the dependency graph as explicit `deps` arrays
(qids), **not** as the array's order. The scheduler instantiates every story
as a pending promise up front and resolves dependencies by qid, so the order of
entries in `STORIES` is irrelevant — it need not be topologically sorted. What
matters is that each story's `deps` array exactly mirrors the inter-story
dependency edges produced during loom planning, which are authoritative.

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

## Generation procedure

Generation happens **in the skill's main thread** (not inside a dispatched
subagent). You read loom at this point; do not call `loom ready`, `loom dep list`,
or `loom show` inside the generated script itself.

### Step 1 — Gather structure from loom

```bash
# For epic mode: get all stories under the epic in dep order
loom order --recursive --json <epic_qid>   # returns stories (type=story)

# For each story, get its deps (inter-story edges only)
loom dep list --json <story_qid>           # returns items the story depends on
```

Filter `loom order` output to `type === "story"`. For each story, filter
`loom dep list` to dependencies that are themselves stories (qids within the
same epic). This gives you the inter-story DAG.

### Step 2 — Assemble the `STORIES` literal

Build a JSON array following this shape exactly:

```json
[
  { "qid": "proj:epicid:1", "title": "Story title", "deps": [] },
  { "qid": "proj:epicid:2", "title": "Story 2",     "deps": ["proj:epicid:1"] },
  { "qid": "proj:epicid:3", "title": "Story 3",     "deps": ["proj:epicid:1"] }
]
```

- `qid` — the story's qualified id.
- `title` — for human-readable logging inside the generated script.
- `deps` — array of **story** qids this story depends on (empty array if none).

### Step 3 — Fill placeholder tokens

Templates live at:
- `plugin/skills/writing-workflows/templates/epic-runner.template.js`
- `plugin/skills/writing-workflows/templates/story-runner.template.js`

**Epic template tokens** (replace literally, including surrounding quotes):

| Token | Replace with |
|-------|-------------|
| `'__EPIC_QID__'` | `'<actual epic qid>'` |
| `'__FINALIZE__'` | `'pr'` or `'merge'` |
| `__STORIES_JSON__` | the JSON array from Step 2 (no surrounding quotes) |

**Story template tokens:**

| Token | Replace with |
|-------|-------------|
| `'__STORY_QID__'` | `'<actual story qid>'` |
| `'__FINALIZE__'` | `'pr'` or `'merge'` |

### Step 4 — Write to output path

```
slug = <qid with ':' replaced by '-'>
output = .loom/workflows/<slug>.workflow.js
```

Create `.loom/workflows/` if it does not exist. `.loom/` is already gitignored,
so the generated file never enters the repo.

```bash
mkdir -p .loom/workflows
# write filled template to .loom/workflows/<slug>.workflow.js
```

### Step 5 — Launch

```js
Workflow({
  scriptPath: "<absolute path to .loom/workflows/<slug>.workflow.js>",
  args: {}
})
```

Pass `args: {}` — all plan-specific data is baked into the script; no runtime
arguments are needed.

## Structural note: EnterWorktree-before-spawn

Generated epic workflows must enter the shared trunk worktree **before**
dispatching any story-executor subagent. This is the EnterWorktree-before-spawn
pattern and it is required for correct bgIsolation behavior.

When a harness session enters a worktree (via `EnterWorktree`), the session's
isolation context is set for that directory. Subagents spawned from within that
context inherit the isolation and can use `Edit`/`Write` tools without hitting
the bgIsolation guard. Subagents spawned **before** the trunk worktree is entered
have no isolation context and will hit the guard on their first file write.

**Correct order in the generated script:**

1. Create the epic's shared trunk branch and worktree (`git worktree add`).
2. Enter the trunk worktree (`EnterWorktree` or `cd` to the trunk path).
3. Then dispatch story-executor subagents.

**Wrong order (do not generate this):**

- Dispatch story-executors from the repo root before entering the trunk worktree.

This is a documentation note for workflow authors; the generated template already
follows the correct order. If you are modifying a template, verify that
`EnterWorktree` (or equivalent worktree entry) precedes all `SubagentExecute`
/ subagent dispatch calls.

## Launch & constraints

### Launch call

After writing the generated file, launch it:

```js
Workflow({
  scriptPath: "/absolute/path/to/.loom/workflows/<slug>.workflow.js",
  args: {}
})
```

The `scriptPath` must be an **absolute** path. All plan-specific data is baked
into the script; `args` is always an empty object.

### Self-contained scripts

Generated workflows must be **self-contained**: no `import` or `require` of
external modules or repo files. All machinery is inlined from the template. This
is required because `Workflow()` scripts execute in a fresh environment without
access to the loom Python library or plugin helpers.

### No runtime `loom` reads in the baked scheduler

The generated epic workflow scheduler must not call `loom ready`, `loom show`,
`loom dep list`, `loom order`, or any other loom CLI at execution time to decide
which story to run next. Story ordering and dependency edges are baked into the
`STORIES` literal at generation time. The scheduler only consults that literal
and the in-memory central outcome store.

Exception: story-executor subagents (dispatched by the generated script) are
still expected to call `loom show`, `loom order`, and `loom update` to read
their per-story task detail. This is out of scope for the generated workflow
itself.

### Agents still read loom

Story-executor subagents continue to read loom items (`loom show`, `loom order
<story_qid>`) to get task lists and validation criteria. The generated workflow
does **not** bake task-level data into the scripts dispatched to story
executors — that would couple the generated artifact to every downstream task
change. Only the orchestrator-level data (story qids, titles, inter-story deps)
is baked.

### finalize values

| Value | Effect |
|-------|--------|
| `"pr"` | Open a pull request from the epic/story branch (default) |
| `"merge"` | Merge into `main` and push — use only when the user explicitly requests it |

## Worked example

### Scenario

An epic `myproject:abc2345` has three stories:

- **S1** `myproject:abc2345:1` — "Bootstrap DB schema" (no deps)
- **S2** `myproject:abc2345:2` — "Add API layer" (depends on S1)
- **S3** `myproject:abc2345:3` — "Add UI layer" (depends on S1)

S2 and S3 can run in parallel once S1 is done.

### Step 2 output — assembled `STORIES` literal

```json
[
  {
    "qid":   "myproject:abc2345:1",
    "title": "Bootstrap DB schema",
    "deps":  []
  },
  {
    "qid":   "myproject:abc2345:2",
    "title": "Add API layer",
    "deps":  ["myproject:abc2345:1"]
  },
  {
    "qid":   "myproject:abc2345:3",
    "title": "Add UI layer",
    "deps":  ["myproject:abc2345:1"]
  }
]
```

### Before → after: baked-data block in the template

**Before (template tokens):**

```js
const EPIC_QID  = '__EPIC_QID__';
const FINALIZE  = '__FINALIZE__';
const STORIES   = __STORIES_JSON__;
```

**After (filled values for this scenario):**

```js
const EPIC_QID  = 'myproject:abc2345';
const FINALIZE  = 'pr';
const STORIES   = [
  {
    qid:   'myproject:abc2345:1',
    title: 'Bootstrap DB schema',
    deps:  []
  },
  {
    qid:   'myproject:abc2345:2',
    title: 'Add API layer',
    deps:  ['myproject:abc2345:1']
  },
  {
    qid:   'myproject:abc2345:3',
    title: 'Add UI layer',
    deps:  ['myproject:abc2345:1']
  }
];
```

### Output path for this scenario

```
slug   = myproject-abc2345
output = .loom/workflows/myproject-abc2345.workflow.js
```

All three story runs are registered up front; the data dependencies drive
execution:

1. S1's run has no deps, so it dispatches immediately.
2. S2's and S3's runs each `await` S1's outcome from the central store. When S1
   merges and records `{ ok: true }`, both unblock and run their executors
   concurrently (their merges still serialize through the merge gate).
3. When both S2 and S3 have recorded `ok` outcomes, `Promise.all` over the runs
   resolves; the script proceeds to inter-story validation and finalize.

