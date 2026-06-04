/**
 * DagView — Graph view: story-dependency DAG for a selected epic.
 *
 * Uses React Flow for rendering and dagre (via dagLayout.ts) for layout.
 * The view is read-only: node dragging is disabled.
 *
 * Layout:
 *  - Left side: <ReactFlow> canvas with dagre-positioned story nodes + dep edges
 *  - Right side: <EpicPickerDrawer> to switch which epic is in scope
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

import type { ProjectSummary, ItemNode, TreeResponse } from "../api/client";
import { getProjectTree } from "../api/client";
import { dagLayout } from "../dagLayout";
import StoryNode from "./StoryNode";
import EpicPickerDrawer from "./EpicPickerDrawer";

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

/** Extract all epic-type nodes from a flat item list. */
function extractEpics(items: ItemNode[]): ItemNode[] {
  return items.filter((n) => n.type === "epic");
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
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEpicQid, setSelectedEpicQid] = useState<string | null>(null);

  // Fetch project tree on mount / project change.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setTree(null);
    setSelectedEpicQid(null);

    getProjectTree(project.qid)
      .then((t) => {
        setTree(t);
        // Auto-select the first epic.
        const epics = extractEpics(t.items);
        if (epics.length > 0) {
          setSelectedEpicQid(epics[0].qid);
        }
      })
      .catch((err: unknown) => {
        setError(String(err));
      })
      .finally(() => setLoading(false));
  }, [project.qid]);

  const epics = useMemo(() => (tree ? extractEpics(tree.items) : []), [tree]);

  const stories = useMemo(
    () => (tree && selectedEpicQid ? storiesForEpic(tree.items, selectedEpicQid) : []),
    [tree, selectedEpicQid],
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

  if (loading) {
    return (
      <div className="view-scroll dag-loading">
        <span>Loading graph…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="view-scroll dag-error">
        <span>Failed to load graph: {error}</span>
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
