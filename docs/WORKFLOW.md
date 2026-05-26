# Loom as a project-management backend for AI coding agents

This document describes a workflow pattern: using loom items as the durable
state for an agent-driven planning + execution loop. The pattern is independent
of any specific agent toolkit, though the reference implementation is in
the [superpowers](https://github.com/obra/superpowers) plugin for Claude Code.

## The pattern

1. **Groom**: a "rough idea" is researched and turned into a structured
   loom epic (large-scale) or story (small-scale) with:
   - A `## Validation Criteria` section in the body (observable checklist)
   - Child stories (for epics) or child tasks (for stories)
   - Dependencies via `loom dep add`
2. **Plan**: items are materialized via `loom epic create`, `loom story create`,
   `loom task create` (with `--body-file` for structured bodies). The
   `assignee` field is set on epics and stories to record ownership.
3. **Execute**: agents pick up ready work via `loom ready <parent-qid>` and
   walk dep-order via `loom order <qid>`. As tasks complete, they call
   `loom complete <qid>`. Status flows from `ready` → `in_progress` → `done`.
4. **Integrate**: completed work is merged into a parent branch. The
   `## Validation Criteria` section is checked against the merged state.
5. **Discard and retry**: failed merges or failed validation use
   `loom reopen <qid>` to reset the item back to ready for the next pass.

## Roles

| Concept | Loom primitive |
|---|---|
| Large feature, multi-subsystem change | Epic |
| Self-contained scoped change | Story under an epic (often the `backlog` epic) |
| Atomic implementation step | Task under a story |
| Dependency between work items | `loom dep add` |
| "What can start right now?" | `loom ready [<qid>]` |
| "Walk this work in dep-order" | `loom order <qid>` |
| "Reset this work for retry" | `loom reopen <qid>` |
| Ownership marker | `assignee` field (see MARKDOWN_SPEC.md §Assignment) |

## Validation criteria

A `## Validation Criteria` markdown section in the body of every story and
epic provides an observable definition of done. Loom does not parse this
section; it's a convention that external validators check. Criteria should
be observable from "criteria + final code state" alone, without
implementation context.

## See also

- `docs/MARKDOWN_SPEC.md` — file format and field conventions
- The [superpowers loom integration spec](https://github.com/obra/superpowers/blob/main/docs/plans/2026-05-22-loom-backed-planning-design.md)
  for the reference implementation
