---
name: brainstorming
description: "You MUST use this before any creative work — creating features, building components, adding functionality, or modifying behavior. Loom-backed groom phase: research the codebase, ask clarifying questions, draft a loom epic or story with validation criteria, hand off to writing-plans."
---

# Brainstorming — loom-backed groom phase

This skill is the entry point for all planning work. It produces a **groomed draft** that the writing-plans skill materializes as loom items.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, or take any implementation action until you have presented the groomed draft and the user has approved it.
</HARD-GATE>

## Scope decision (first action)

If you were dispatched with a `mode=epic` or `mode=story` hint in your prompt (i.e., from `/epic` or `/story`), use that mode.

If no mode is pre-seeded (you were auto-triggered or invoked plain), **first decide the scope**:

| Scope | Pick when |
|---|---|
| **epic** | End-to-end feature, multi-subsystem refactor, change touches multiple modules with non-trivial dep relationships, expected to take many commits / many hours |
| **story** | Single-file or scoped change, self-contained behavior modification, bugfix, one or a few related functions |

Borderline case? Ask the user one question with the two options and let them decide.

## Mandatory checklist

You MUST use TaskCreate to add a Task List item for each of these and complete in order:

1. **Bind loom to this repo** — walk up from cwd looking for `.loom/state.json`. If absent, run `loom -y project create <repo-basename>` (loom auto-discovers the `origin` remote). Capture the project qid.
2. **Dispatch the codebase-researcher agent** with the user's description and the repo root. Wait for its report (~under 400 words).
3. **Ask clarifying questions** — one at a time. Use the research report to ground each question in concrete context (files, symbols, behaviors). Prefer multiple-choice questions when possible. Cover: purpose, constraints, success criteria, out-of-scope.
4. **Propose 2-3 approaches** with trade-offs and your recommendation. (Skip for trivial bug-fix stories.)
5. **Assemble the groomed draft** in conversation (no file written yet) — see the structure below.
6. **Present the draft** for user approval. Iterate until they approve.
7. **Hand off to writing-plans** with the approved draft + scope + project qid + session id.

## Groomed draft structure

**Every story in the draft MUST carry an ordered list of granular tasks.** Each task is scoped to a single line or single-function change and the list is sequenced as a step-by-step manual for completing the story. Granular ordered tasks make execution and validation tractable — without them a story executor cannot make reliable incremental progress or verify partial work.

For **epic** mode, the draft includes:

```
- title: <short epic title>
- body sections:
    - Summary: 1-paragraph what-and-why
    - Context: relevant files/symbols from research
    - Validation Criteria (checklist): observable, no implementation detail
    - Implementation Notes: approach + key decisions from this session
    - Out of Scope
- child stories: list of {title, body sections (same shape), parent epic, deps on other stories, child tasks: ordered list of {title, body (required), deps on other tasks} — each task scoped to a single line or single-function change; at least one task required per story}
```

For **story** mode, the draft includes:

```
- title: <short story title>
- body sections (same as epic): Summary, Context, Validation Criteria, Implementation Notes, Out of Scope
- child tasks: ordered list of {title, body (required), deps on other tasks} — each task scoped to a single line or single-function change, sequenced as a step-by-step manual to completing the story; at least one task is required
```

**Validation criteria rules:**
- Each criterion is observable from "criteria + final code state" alone — no "uses a hashmap" type implementation detail
- May name expected behaviors, expected files/functions, expected test outcomes
- Both story and epic bodies MUST contain a `## Validation Criteria` section
- Tasks do NOT carry validation criteria (they're too granular)

## Constraints

- **No design doc file is written.** The groomed draft goes straight into loom items at the writing-plans step.
- **Never skip the research step** even when the description seems detailed. Grounding the conversation in concrete files/symbols is what makes the criteria observable.
- **Loom is the only backend.** If the consumer repo can't be bound to a loom project (e.g., not a git repo), surface the failure and stop. There is no fallback path.

## Transition

When the user approves the groomed draft, invoke **`superpowers:writing-plans`** with the draft, scope, project qid, and `${CLAUDE_SESSION_ID}` (the writing-plans skill uses the session id to set `assignee` on the created items).

`writing-plans` is the only skill you hand off to.
