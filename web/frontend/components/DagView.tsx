/**
 * DagView — Graph view: story-dependency DAG for a selected epic.
 *
 * Uses React Flow for rendering and dagre (via dagLayout.ts) for layout.
 * The view is read-only: node dragging is disabled.
 *
 * Layout:
 *  - Left side: <ReactFlow> canvas with dagre-positioned story nodes + dep edges
 *  - Right side: <EpicPickerDrawer> to switch which epic is in scope
 *
 * Rows are derived from the store's itemsById so that SSE-delivered
 * updates appear without a manual refresh.
 */

import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type NodeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { ItemNode } from "../api/client";
import { dagLayout } from "../dagLayout";
import { sortEpicsNewestFirst } from "../epicSort";
import StoryNode from "./StoryNode";
import EpicPickerDrawer from "./EpicPickerDrawer";
import { useAppStore } from "../state/store";
import type { ProjectSummary } from "../api/client";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DagViewProps {
  project: ProjectSummary;
  onOpen: (qid: string) => void;
}

// ---------------------------------------------------------------------------
// React Flow node types registry
// ---------------------------------------------------------------------------

const NODE_TYPES: NodeTypes = {
  storyNode: StoryNode as unknown as NodeTypes["storyNode"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract all epic-type nodes from a flat item list, sorted newest-first. */
function extractEpics(items: ItemNode[]): ItemNode[] {
  const byQid = new Map(items.map((n) => [n.qid, n]));
  const epicQids = items.filter((n) => n.type === "epic").map((n) => n.qid);
  return sortEpicsNewestFirst(epicQids, byQid).map((qid) => byQid.get(qid)!);
}

/** Extract all story-type nodes that are direct children of a given epic. */
function storiesForEpic(items: ItemNode[], epicQid: string): ItemNode[] {
  const epicNode = items.find((n) => n.qid === epicQid);
  if (!epicNode) return [];
  const childSet = new Set(epicNode.children);
  return items.filter((n) => n.type === "story" && childSet.has(n.qid));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DagView({ project, onOpen }: DagViewProps): React.JSX.Element {
  const { itemsById } = useAppStore();
  const [selectedEpicQid, setSelectedEpicQid] = useState<string | null>(null);

  // Derive items array from store.
  const items = useMemo<ItemNode[]>(
    () => (itemsById ? Object.values(itemsById) : []),
    [itemsById],
  );

  const epics = useMemo(() => extractEpics(items), [items]);

  // Auto-select the first epic when epics load or change.
  useEffect(() => {
    if (epics.length > 0 && !selectedEpicQid) {
      setSelectedEpicQid(epics[0].qid);
    }
  }, [epics, selectedEpicQid]);

  // Reset selected epic when project changes.
  useEffect(() => {
    setSelectedEpicQid(null);
  }, [project.qid]);

  const stories = useMemo(
    () => (selectedEpicQid ? storiesForEpic(items, selectedEpicQid) : []),
    [items, selectedEpicQid],
  );

  const { nodes, edges } = useMemo(() => dagLayout(stories), [stories]);

  // Node click → open item modal.
  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      onOpen(node.id);
    },
    [onOpen],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!itemsById) {
    return (
      <div className="view-scroll dag-loading">
        <span>Loading graph…</span>
      </div>
    );
  }

  if (epics.length === 0) {
    return (
      <div className="view-scroll dag-empty">
        <span>No epics found for this project.</span>
      </div>
    );
  }

  return (
    <div className="dag-wrap">
      {/* React Flow canvas */}
      <div className="dag-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          onNodeClick={handleNodeClick}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: false }}
        >
          <Background color="var(--border)" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* Epic picker drawer */}
      <EpicPickerDrawer
        epics={epics}
        selectedEpicQid={selectedEpicQid}
        onSelectEpic={setSelectedEpicQid}
      />
    </div>
  );
}
