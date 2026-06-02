/**
 * tableModel — pure transform: TreeResponse → TableRow[]
 *
 * Flattens the epic▸story▸task tree into an ordered, visible-row list
 * respecting the caller-provided collapse state. No React; no side effects.
 *
 * Column spec (matching the reference design):
 *   Name 40% / Progress 22% / Status 20% / Updated 18%
 */

import type { TreeResponse, ItemNode } from "./api/client";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export interface TableColumn {
  key: string;
  label: string;
  widthPct: number;
}

export const TABLE_COLUMNS: ReadonlyArray<TableColumn> = [
  { key: "name",     label: "Name",     widthPct: 40 },
  { key: "progress", label: "Progress", widthPct: 22 },
  { key: "status",   label: "Status",   widthPct: 20 },
  { key: "updated",  label: "Updated",  widthPct: 18 },
];

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface TableRow {
  qid: string;
  type: string;
  title: string;
  status: string | null;
  /** Nesting depth: 0=epic, 1=story, 2=task */
  depth: number;
  /** Whether this row has any child items (drives chevron display). */
  hasChildren: boolean;
  /** Whether this row is currently collapsed (chevron direction). */
  isCollapsed: boolean;

  // --- Progress fields (null when not applicable) ---

  /** Number of done tasks under this story (null for epic and task rows). */
  taskDone: number | null;
  /** Total tasks under this story (null for epic and task rows). */
  taskTotal: number | null;
  /** Number of done stories under this epic (null for story and task rows). */
  storyDone: number | null;
  /** Total stories under this epic (null for story and task rows). */
  storyTotal: number | null;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Flatten a TreeResponse into visible TableRows given a collapse state map.
 *
 * @param tree         The full tree from GET /api/projects/{project}/tree.
 * @param collapseState Map from qid → true when that row is collapsed.
 * @returns            Ordered list of rows that should be rendered.
 */
export function tableModel(
  tree: TreeResponse,
  collapseState: Record<string, boolean>,
): TableRow[] {
  // Build lookup map.
  const byQid = new Map<string, ItemNode>();
  for (const node of tree.items) {
    byQid.set(node.qid, node);
  }

  const root = byQid.get(tree.root);
  if (!root) return [];

  const rows: TableRow[] = [];

  // Walk epics (depth 0).
  for (const epicQid of root.children) {
    const epicNode = byQid.get(epicQid);
    if (!epicNode || epicNode.type !== "epic") continue;

    const epicCollapsed = !!collapseState[epicQid];
    const epicHasChildren = epicNode.children.length > 0;

    // Compute story-level progress for this epic.
    let storyTotal = 0;
    let storyDone = 0;
    for (const sqid of epicNode.children) {
      const sn = byQid.get(sqid);
      if (!sn || sn.type !== "story") continue;
      storyTotal++;
      if (sn.status === "done") storyDone++;
    }

    rows.push({
      qid: epicQid,
      type: "epic",
      title: epicNode.title,
      status: epicNode.status,
      depth: 0,
      hasChildren: epicHasChildren,
      isCollapsed: epicCollapsed,
      taskDone: null,
      taskTotal: null,
      storyDone,
      storyTotal,
    });

    if (epicCollapsed) continue;

    // Walk stories (depth 1).
    for (const storyQid of epicNode.children) {
      const storyNode = byQid.get(storyQid);
      if (!storyNode || storyNode.type !== "story") continue;

      const storyCollapsed = !!collapseState[storyQid];
      const taskChildren = storyNode.children
        .map((tqid) => byQid.get(tqid))
        .filter((n): n is ItemNode => n !== undefined && n.type === "task");
      const storyHasChildren = taskChildren.length > 0;

      const taskTotal = taskChildren.length;
      const taskDone = taskChildren.filter((t) => t.status === "done").length;

      rows.push({
        qid: storyQid,
        type: "story",
        title: storyNode.title,
        status: storyNode.status,
        depth: 1,
        hasChildren: storyHasChildren,
        isCollapsed: storyCollapsed,
        taskDone,
        taskTotal,
        storyDone: null,
        storyTotal: null,
      });

      if (storyCollapsed) continue;

      // Walk tasks (depth 2).
      for (const taskNode of taskChildren) {
        rows.push({
          qid: taskNode.qid,
          type: "task",
          title: taskNode.title,
          status: taskNode.status,
          depth: 2,
          hasChildren: false,
          isCollapsed: false,
          taskDone: null,
          taskTotal: null,
          storyDone: null,
          storyTotal: null,
        });
      }
    }
  }

  return rows;
}
