/**
 * dagLayout — pure fn: stories + deps → React Flow nodes/edges with dagre positions.
 *
 * Takes an array of story ItemNode objects scoped to one epic and produces
 * React Flow–compatible nodes and edges with x/y positions computed by dagre
 * in a left→right layered layout.
 *
 * No React; no side effects; fully unit-testable.
 */

import dagre from "dagre";
import type { ItemNode } from "./api/client";

// ---------------------------------------------------------------------------
// Output types (compatible with React Flow Node/Edge shapes)
// ---------------------------------------------------------------------------

export interface DagNode {
  id: string;
  position: { x: number; y: number };
  data: {
    qid: string;
    title: string;
    status: string | null;
  };
  /** React Flow node type name. */
  type: "storyNode";
}

export interface DagEdge {
  id: string;
  source: string;
  target: string;
  /** Animated edge for dependency arrows. */
  animated: false;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Estimated node width for dagre spacing. */
const NODE_W = 200;
/** Estimated node height for dagre spacing. */
const NODE_H = 72;
/** Horizontal gap between layers. */
const RANK_SEP = 80;
/** Vertical gap between nodes in the same layer. */
const NODE_SEP = 24;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute a dagre left→right layout for the stories within one epic.
 *
 * Only story-to-story dep edges that are among the provided stories are
 * included. Cross-epic deps are silently dropped (they can't be laid out
 * in the same graph without the full tree).
 *
 * @param stories - ItemNode array; typically all story-type nodes in an epic.
 * @returns DagLayout with positioned nodes and edges.
 */
export function dagLayout(stories: ItemNode[]): DagLayout {
  // Build a set of qids in scope so we can filter cross-epic edges.
  const inScope = new Set(stories.map((s) => s.qid));

  // Set up dagre graph.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: RANK_SEP, nodesep: NODE_SEP });
  g.setDefaultEdgeLabel(() => ({}));

  // Add nodes.
  for (const story of stories) {
    g.setNode(story.qid, { width: NODE_W, height: NODE_H });
  }

  // Add edges (in-scope story deps only).
  const edgeDefs: Array<{ source: string; target: string }> = [];
  for (const story of stories) {
    for (const depQid of story.deps) {
      if (inScope.has(depQid)) {
        // In loom, `deps` means "this story depends on depQid", so
        // depQid must be done first → edge flows depQid → story.qid.
        g.setEdge(depQid, story.qid);
        edgeDefs.push({ source: depQid, target: story.qid });
      }
    }
  }

  // Run layout.
  dagre.layout(g);

  // Build output nodes.
  const nodes: DagNode[] = stories.map((story) => {
    const nodeLayout = g.node(story.qid);
    return {
      id: story.qid,
      position: {
        // dagre returns center coordinates; React Flow also uses center by default
        // when origin is set — keep as-is; ReactFlow's default origin is top-left,
        // so we offset by half node dimensions.
        x: nodeLayout.x - NODE_W / 2,
        y: nodeLayout.y - NODE_H / 2,
      },
      data: {
        qid: story.qid,
        title: story.title ?? story.qid,
        status: story.status,
      },
      type: "storyNode" as const,
    };
  });

  // Build output edges.
  const edges: DagEdge[] = edgeDefs.map(({ source, target }) => ({
    id: `${source}-->${target}`,
    source,
    target,
    animated: false,
  }));

  return { nodes, edges };
}
