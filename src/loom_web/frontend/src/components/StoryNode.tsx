/**
 * StoryNode — custom React Flow node for a story in the DAG view.
 *
 * Displays: status dot, story title, and the short qid suffix.
 * Clicking the node fires onNodeClick in the React Flow parent, which is
 * wired to openModal in the DagView.
 */

import React from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { statusColor } from "../status";
import { enterClass } from "./enterClass";
import { statusChip } from "./statusChip";

// ---------------------------------------------------------------------------
// Data shape (matches DagNode.data from dagLayout.ts)
// ---------------------------------------------------------------------------

export interface StoryNodeData {
  qid: string;
  title: string;
  status: string | null;
  /** When true, adds the .loom-enter animation class (newly added via WS). */
  isNew?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StoryNode({ data }: NodeProps<{ data: StoryNodeData }>): React.JSX.Element {
  const { qid, title, status, isNew } = data as unknown as StoryNodeData;
  const colors = statusColor(status);

  // Show only the last segment of the qid for brevity (e.g. "3" from "p:abc:3").
  const shortId = qid.split(":").pop() ?? qid;

  return (
    <div className={enterClass("snode", isNew)}>
      {/* Incoming edge handle (left side) */}
      <Handle type="target" position={Position.Left} className="snode-handle" />

      <div className="snode-header">
        <span
          className={statusChip("snode-dot")}
          style={{ background: colors.dot }}
          aria-label={status ?? "unknown status"}
        />
        <span className="snode-id">#{shortId}</span>
      </div>

      <div className="snode-title">{title}</div>

      {status && (
        <div
          className={statusChip("snode-status")}
          style={{ color: colors.fg, background: colors.bg }}
        >
          {status}
        </div>
      )}

      {/* Outgoing edge handle (right side) */}
      <Handle type="source" position={Position.Right} className="snode-handle" />
    </div>
  );
}
