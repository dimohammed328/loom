#!/usr/bin/env bash
# scripts/loom-log-event.sh — append one JSONL event line to the orchestrator log.
#
# Usage:
#   loom-log-event.sh \
#     --kind <event-kind>          # required
#     --epic-qid <qid>             # required
#     --agent-id <id>              # required
#     --session-id <id>            # required
#     --agent-type <type>          # required
#     [--story-qid <qid>]          # optional
#     [--task-qid <qid>]           # optional
#     [--note <text>]              # optional
#     [--field key=value] ...      # repeatable; adds arbitrary payload fields
#
# Output path:
#   ${XDG_STATE_HOME:-$HOME/.local/state}/loom/<project>/<epic_qid>/<agent_id>.jsonl
#
# The <project> is derived from the nearest .loom/state.json walking up from cwd.
# Never prints to stdout on success. All diagnostics go to stderr.

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
kind=""
epic_qid=""
agent_id=""
session_id=""
agent_type=""
story_qid=""
task_qid=""
note=""
declare -a extra_fields=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)        kind="$2";       shift 2 ;;
    --epic-qid)    epic_qid="$2";   shift 2 ;;
    --agent-id)    agent_id="$2";   shift 2 ;;
    --session-id)  session_id="$2"; shift 2 ;;
    --agent-type)  agent_type="$2"; shift 2 ;;
    --story-qid)   story_qid="$2";  shift 2 ;;
    --task-qid)    task_qid="$2";   shift 2 ;;
    --note)        note="$2";       shift 2 ;;
    --field)
      extra_fields+=("$2")
      shift 2
      ;;
    *)
      echo "loom-log-event: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Required-field validation
# ---------------------------------------------------------------------------
missing=()
[[ -z "$kind" ]]       && missing+=("--kind")
[[ -z "$epic_qid" ]]   && missing+=("--epic-qid")
[[ -z "$agent_id" ]]   && missing+=("--agent-id")
[[ -z "$session_id" ]] && missing+=("--session-id")
[[ -z "$agent_type" ]] && missing+=("--agent-type")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "loom-log-event: missing required arguments: ${missing[*]}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Derive project from nearest .loom/state.json
# ---------------------------------------------------------------------------
find_project() {
  local dir="$PWD"
  while true; do
    local state="${dir}/.loom/state.json"
    if [[ -f "$state" ]]; then
      local proj
      proj=$(jq -r '.project // ""' "$state" 2>/dev/null)
      if [[ -n "$proj" ]]; then
        echo "$proj"
        return 0
      fi
    fi
    # Stop at filesystem root
    local parent
    parent=$(dirname "$dir")
    if [[ "$parent" == "$dir" ]]; then
      break
    fi
    dir="$parent"
  done
  echo "loom-log-event: no .loom/state.json with 'project' field found (cwd: $PWD)" >&2
  exit 1
}

project=$(find_project)

# ---------------------------------------------------------------------------
# Resolve output path
# ---------------------------------------------------------------------------
state_home="${XDG_STATE_HOME:-${HOME}/.local/state}"
log_dir="${state_home}/loom/${project}/${epic_qid}"
log_file="${log_dir}/${agent_id}.jsonl"

mkdir -p "$log_dir"

# ---------------------------------------------------------------------------
# Timestamp (millisecond precision; fall back if %N unsupported, e.g. macOS)
# ---------------------------------------------------------------------------
ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null)
# On macOS, date doesn't support %N — the literal "3N" appears in output
if [[ "$ts" == *"%"* ]] || [[ "$ts" == *"3N"* ]] || [[ "$ts" == *"N"* ]]; then
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi

# ---------------------------------------------------------------------------
# Build JSONL line with jq
# ---------------------------------------------------------------------------

# Start with required fields
jq_args=(
  --arg schema_version "1"
  --arg ts "$ts"
  --arg kind "$kind"
  --arg epic_qid "$epic_qid"
  --arg agent_id "$agent_id"
  --arg session_id "$session_id"
  --arg agent_type "$agent_type"
)

# Build the base expression
jq_expr='{
  schema_version: ($schema_version | tonumber),
  ts: $ts,
  kind: $kind,
  epic_qid: $epic_qid,
  agent_id: $agent_id,
  session_id: $session_id,
  agent_type: $agent_type
}'

# Append optional fields conditionally
if [[ -n "$story_qid" ]]; then
  jq_args+=(--arg story_qid "$story_qid")
  jq_expr="${jq_expr} + {story_qid: \$story_qid}"
fi

if [[ -n "$task_qid" ]]; then
  jq_args+=(--arg task_qid "$task_qid")
  jq_expr="${jq_expr} + {task_qid: \$task_qid}"
fi

if [[ -n "$note" ]]; then
  jq_args+=(--arg note "$note")
  jq_expr="${jq_expr} + {note: \$note}"
fi

# Append --field key=value pairs
for kv in "${extra_fields[@]+"${extra_fields[@]}"}"; do
  # Split on first '='
  fkey="${kv%%=*}"
  fval="${kv#*=}"
  jq_args+=(--arg "field_${fkey}" "$fval")
  jq_expr="${jq_expr} + {\"${fkey}\": \$field_${fkey}}"
done

# ---------------------------------------------------------------------------
# Write JSONL line (append)
# ---------------------------------------------------------------------------
jq -c -n "${jq_args[@]}" "$jq_expr" >> "$log_file"
