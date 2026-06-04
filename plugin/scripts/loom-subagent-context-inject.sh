#!/usr/bin/env bash
# SubagentStart hook: inject loom workflow context for our defined agent types.
#
# Reads JSON on stdin with fields { session_id, agent_id, agent_type, ... }.
# Returns JSON with hookSpecificOutput.additionalContext for matching types.
# Returns nothing (silent exit 0) for non-matching types.
#
# See docs/plans/2026-05-22-loom-backed-planning-design.md §5.2 + §6.

set -euo pipefail

# Observed SubagentStart payload schema (verified 2026-05-26 against live Claude Code dispatch):
#
#   {
#     "session_id": "<uuid>",   -- Claude session identifier (e.g. "01jw5jqnrreff8bqcxqnrsgqrd")
#     "agent_id":   "<uuid>",   -- Subagent instance identifier (e.g. "01jw5jqp25b6ga55xaqp0r6mqy")
#     "agent_type": "<string>"  -- Agent definition name (e.g. "story-executor")
#   }
#
# Both session_id and agent_id are UUID-format strings when Claude Code dispatches a real
# subagent. The hook reads both via jq paths .session_id and .agent_id (confirmed correct).

input=$(cat)
agent_type=$(jq -r '.agent_type // ""' <<<"$input")

case "$agent_type" in
  story-executor|epic-validator|codebase-researcher)
    : # fall through to inject context
    ;;
  *)
    exit 0  # permissive — no injection for other agents
    ;;
esac

session_id=$(jq -r '.session_id // "unknown"' <<<"$input")
agent_id=$(jq -r '.agent_id // "unknown"' <<<"$input")

# The injected block tells the subagent who it is and what loom expects
# of it. Story-executor agents must self-attribute via `loom update`.
context=$(cat <<EOF
## Loom Workflow Context

- session_id: ${session_id}
- agent_id: ${agent_id}
- agent_type: ${agent_type}

If you are a **story-executor**: as your FIRST action, run the command
shown below **verbatim** (the session and agent values are already
pre-filled — do NOT modify them). Replace only \`<story-qid>\` with the
story qid passed in your prompt:

\`\`\`bash
loom update <story-qid> assignee ${session_id}:${agent_id}
\`\`\`

This claims ownership for the audit trail.

Read the story body (with \`## Validation Criteria\`) via
\`loom show <story-qid>\` and get the topological task list via
\`loom order <story-qid>\`.
EOF
)

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    additionalContext: $ctx
  }
}'
