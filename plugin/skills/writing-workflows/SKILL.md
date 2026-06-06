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

