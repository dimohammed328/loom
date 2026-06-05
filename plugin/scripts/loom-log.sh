#!/usr/bin/env bash
# scripts/loom-log.sh — dispatcher hook for agent lifecycle event logging.
#
# Wired to: PostToolUse (matcher: Bash), SubagentStart, SubagentStop,
#           WorktreeCreate, WorktreeRemove
#
# Reads stdin JSON, detects event type from $CLAUDE_HOOK_EVENT env var
# (or infers from JSON shape if unset), extracts relevant fields, and
# calls scripts/loom-log-event.sh with the appropriate --kind and
# --field arguments.
#
# FAIL-OPEN: any error → stderr diagnostic → exit 0.
# Never blocks the user's action.

# Do NOT use set -euo pipefail at top level — we need fail-open semantics.
# Each helper function can use local set -e but the top-level trap handles all.

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${HOOK_DIR}/loom-log-event.sh"

# ---------------------------------------------------------------------------
# Fail-open error trap
# ---------------------------------------------------------------------------
_loom_log_error() {
  local line="$1"
  echo "loom-log.sh: error on line ${line} — logging skipped (fail-open)" >&2
}
trap '_loom_log_error $LINENO' ERR

# ---------------------------------------------------------------------------
# Read stdin
# ---------------------------------------------------------------------------
input=""
if ! input=$(cat 2>/dev/null); then
  echo "loom-log.sh: failed to read stdin — skipping" >&2
  exit 0
fi

# Validate that stdin is parseable JSON; if not, emit diagnostic and exit 0.
if ! echo "$input" | jq empty 2>/dev/null; then
  echo "loom-log.sh: stdin is not valid JSON — skipping (fail-open)" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Detect event kind
# ---------------------------------------------------------------------------
event="${CLAUDE_HOOK_EVENT:-}"
if [[ -z "$event" ]]; then
  # Infer from JSON shape
  tool_name=$(echo "$input" | jq -r '.tool_name // ""' 2>/dev/null)
  if [[ -n "$tool_name" ]]; then
    event="PostToolUse"
  elif echo "$input" | jq -e '.worktree_path' >/dev/null 2>&1; then
    # Could be WorktreeCreate or WorktreeRemove; default to WorktreeCreate
    event="WorktreeCreate"
  elif echo "$input" | jq -e '.agent_type' >/dev/null 2>&1; then
    event="SubagentStart"
  fi
fi

# ---------------------------------------------------------------------------
# Extract common identity fields from the JSON payload
# ---------------------------------------------------------------------------
session_id=$(echo "$input" | jq -r '.session_id // "unknown"' 2>/dev/null)
agent_id=$(echo "$input" | jq -r '.agent_id // "unknown"' 2>/dev/null)
agent_type=$(echo "$input" | jq -r '.agent_type // "unknown"' 2>/dev/null)
epic_qid=$(echo "$input" | jq -r '.epic_qid // ""' 2>/dev/null)
story_qid=$(echo "$input" | jq -r '.story_qid // ""' 2>/dev/null)

# Without epic_qid and agent_id we cannot write a meaningful log entry.
if [[ -z "$epic_qid" || "$epic_qid" == "null" ]]; then
  # Not a loom-context hook invocation — silently skip.
  exit 0
fi

# ---------------------------------------------------------------------------
# Helper: call the log-event helper
# ---------------------------------------------------------------------------
call_helper() {
  local kind="$1"
  shift  # remaining args are --field / --task-qid / --story-qid / --note pairs

  local args=(
    --kind        "$kind"
    --epic-qid    "$epic_qid"
    --agent-id    "$agent_id"
    --session-id  "$session_id"
    --agent-type  "$agent_type"
  )

  [[ -n "$story_qid" && "$story_qid" != "null" ]] && args+=(--story-qid "$story_qid")

  # Append any extra args passed to this function
  args+=("$@")

  "$HELPER" "${args[@]}"
}

# ---------------------------------------------------------------------------
# Branch: SubagentStart → subagent_start
# ---------------------------------------------------------------------------
handle_subagent_start() {
  call_helper "subagent_start"
}

# ---------------------------------------------------------------------------
# Branch: SubagentStop → subagent_stop
# ---------------------------------------------------------------------------
handle_subagent_stop() {
  local exit_code duration
  exit_code=$(echo "$input" | jq -r '.exit_code // ""' 2>/dev/null)
  duration=$(echo "$input" | jq -r '.duration_ms // ""' 2>/dev/null)

  local extra_args=()
  [[ -n "$exit_code" && "$exit_code" != "null" ]] && extra_args+=(--field "exit_code=${exit_code}")
  [[ -n "$duration"  && "$duration"  != "null" ]] && extra_args+=(--field "duration_ms=${duration}")

  call_helper "subagent_stop" "${extra_args[@]}"
}

# ---------------------------------------------------------------------------
# Branch: WorktreeCreate → worktree_create
# ---------------------------------------------------------------------------
handle_enter_worktree() {
  local worktree_path branch
  worktree_path=$(echo "$input" | jq -r '.worktree_path // ""' 2>/dev/null)
  branch=$(echo "$input" | jq -r '.branch // ""' 2>/dev/null)

  local extra_args=()
  [[ -n "$worktree_path" && "$worktree_path" != "null" ]] && extra_args+=(--field "path=${worktree_path}")
  [[ -n "$branch"        && "$branch"        != "null" ]] && extra_args+=(--field "branch=${branch}")

  call_helper "worktree_create" "${extra_args[@]}"
}

# ---------------------------------------------------------------------------
# Branch: WorktreeRemove → worktree_delete
# ---------------------------------------------------------------------------
handle_exit_worktree() {
  local worktree_path branch
  worktree_path=$(echo "$input" | jq -r '.worktree_path // ""' 2>/dev/null)
  branch=$(echo "$input" | jq -r '.branch // ""' 2>/dev/null)

  local extra_args=()
  [[ -n "$worktree_path" && "$worktree_path" != "null" ]] && extra_args+=(--field "path=${worktree_path}")
  [[ -n "$branch"        && "$branch"        != "null" ]] && extra_args+=(--field "branch=${branch}")

  call_helper "worktree_delete" "${extra_args[@]}"
}

# ---------------------------------------------------------------------------
# Branch: PostToolUse(Bash) — regex-match git commands
# ---------------------------------------------------------------------------
handle_bash() {
  local command
  command=$(echo "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

  # git commit
  if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+commit([[:space:]]|$) ]]; then
    local sha=""
    local stdout
    stdout=$(echo "$input" | jq -r '.tool_response.stdout // ""' 2>/dev/null)
    # Attempt to extract sha from output like "[branch abc1234] message"
    if [[ "$stdout" =~ \[([^][:space:]]+)[[:space:]]+([0-9a-f]{6,40})\] ]]; then
      sha="${BASH_REMATCH[2]}"
    fi
    local extra_args=()
    [[ -n "$sha" ]] && extra_args+=(--field "sha=${sha}")
    call_helper "git_commit" "${extra_args[@]}"
    return
  fi

  # git merge
  if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+merge([[:space:]]|$) ]]; then
    # Extract source branch: first non-flag argument after "merge"
    local source_branch=""
    # Simple extraction: look for a word after merge that doesn't start with -
    if [[ "$command" =~ git[[:space:]]+merge[[:space:]]+(--[[:alnum:]-]+[[:space:]]+)*([^[:space:]-][^[:space:]]*) ]]; then
      source_branch="${BASH_REMATCH[2]}"
    fi
    local extra_args=()
    [[ -n "$source_branch" ]] && extra_args+=(--field "source_branch=${source_branch}")
    call_helper "git_merge" "${extra_args[@]}"
    return
  fi

  # git worktree add
  if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+worktree[[:space:]]+add([[:space:]]|$) ]]; then
    call_helper "worktree_create"
    return
  fi

  # git worktree remove
  if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+worktree[[:space:]]+remove([[:space:]]|$) ]]; then
    call_helper "worktree_delete"
    return
  fi

  # git branch -D
  if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+branch[[:space:]]+-D([[:space:]]|$) ]]; then
    # Extract branch name after -D flag
    local branch_name=""
    if [[ "$command" =~ git[[:space:]]+branch[[:space:]]+-D[[:space:]]+([^[:space:]]+) ]]; then
      branch_name="${BASH_REMATCH[1]}"
    fi
    local extra_args=()
    [[ -n "$branch_name" ]] && extra_args+=(--field "branch=${branch_name}")
    call_helper "git_branch_delete" "${extra_args[@]}"
    return
  fi

  # git push
  if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+push([[:space:]]|$) ]]; then
    local remote="" branch_name=""
    # Attempt to extract remote and branch from "git push [opts] <remote> <branch>"
    # Strip flags (words starting with -) and take positional args
    local words=()
    IFS=' ' read -ra words <<< "$command"
    local positional=()
    for word in "${words[@]}"; do
      [[ "$word" == git || "$word" == push ]] && continue
      [[ "$word" =~ ^- ]] && continue
      positional+=("$word")
    done
    [[ ${#positional[@]} -ge 1 ]] && remote="${positional[0]}"
    [[ ${#positional[@]} -ge 2 ]] && branch_name="${positional[1]}"

    local extra_args=()
    [[ -n "$remote" ]]      && extra_args+=(--field "remote=${remote}")
    [[ -n "$branch_name" ]] && extra_args+=(--field "branch=${branch_name}")
    call_helper "git_push" "${extra_args[@]}"
    return
  fi

  # Non-matching Bash command — no event emitted
  exit 0
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------
case "$event" in
  SubagentStart)
    handle_subagent_start
    ;;
  SubagentStop)
    handle_subagent_stop
    ;;
  WorktreeCreate)
    handle_enter_worktree
    ;;
  WorktreeRemove)
    handle_exit_worktree
    ;;
  PostToolUse)
    tool_name=$(echo "$input" | jq -r '.tool_name // ""' 2>/dev/null)
    case "$tool_name" in
      Bash)
        handle_bash
        ;;
      *)
        # Unknown PostToolUse tool — silently skip
        exit 0
        ;;
    esac
    ;;
  *)
    # Unknown event — silently skip (fail-open)
    exit 0
    ;;
esac

exit 0
