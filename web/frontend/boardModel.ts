/**
 * boardModel — pure transform: TreeResponse → EpicRow[]
 *
 * Takes the flat item map from GET /api/projects/{project}/tree and
 * produces a row-per-epic, column-per-status structure that the Board
 * view renders directly. No React; no side effects.
 */

import type { TreeResponse, ItemNode } from "./api/client";
import { sortEpicsNewestFirst } from "./epicSort";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Story-level statuses shown as board columns, in canonical order.
 * "in review" is an epic-level concept and does not appear as a story column.
 */
export const BOARD_STATUSES: ReadonlyArray<string> = [
  "ready",
  "in progress",
  "blocked",
  "done",
];

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface StoryCell {
  qid: string;
  title: string;
  status: string | null;
  /** Dependency qids (other story qids this story depends on). */
  deps: string[];
  /** Direct task children of this story. */
  taskNodes: TaskCell[];
}

export interface TaskCell {
  qid: string;
  title: string;
  status: string | null;
}

export interface EpicRow {
  epicQid: string;
  epicTitle: string;
  /** The epic's own status (used to detect "in review" / "done" review gate). */
  epicStatus: string | null;
  /**
   * Story cells bucketed by status key. Always contains at least the four
   * canonical BOARD_STATUSES; may also contain extra keys for custom statuses.
   */
  statusColumns: Record<string, StoryCell[]>;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Convert a TreeResponse into a list of EpicRows for the Board view.
 *
 * Ordering: epics appear in the order listed in their parent project's
 * `children` array; stories within a column appear in epic-children order.
 */
export function boardModel(tree: TreeResponse): EpicRow[] {
  // Build a lookup map from qid → ItemNode.
  const byQid = new Map<string, ItemNode>();
  for (const node of tree.items) {
    byQid.set(node.qid, node);
  }

  const root = byQid.get(tree.root);
  if (!root) return [];

  const rows: EpicRow[] = [];

  for (const epicQid of sortEpicsNewestFirst(root.children, byQid)) {
    const epicNode = byQid.get(epicQid);
    if (!epicNode || epicNode.type !== "epic") continue;

    // Initialise columns with the canonical statuses.
    const statusColumns: Record<string, StoryCell[]> = {};
    for (const s of BOARD_STATUSES) {
      statusColumns[s] = [];
    }

    for (const storyQid of epicNode.children) {
      const storyNode = byQid.get(storyQid);
      if (!storyNode || storyNode.type !== "story") continue;

      // Collect task children.
      const taskNodes: TaskCell[] = [];
      for (const childQid of storyNode.children) {
        const childNode = byQid.get(childQid);
        if (childNode && childNode.type === "task") {
          taskNodes.push({
            qid: childNode.qid,
            title: childNode.title,
            status: childNode.status,
          });
        }
      }

      const cell: StoryCell = {
        qid: storyNode.qid,
        title: storyNode.title,
        status: storyNode.status,
        deps: storyNode.deps,
        taskNodes,
      };

      const colKey = storyNode.status ?? "ready";
      if (!(colKey in statusColumns)) {
        statusColumns[colKey] = [];
      }
      statusColumns[colKey].push(cell);
    }

    rows.push({
      epicQid: epicNode.qid,
      epicTitle: epicNode.title,
      epicStatus: epicNode.status,
      statusColumns,
    });
  }

  return rows;
}
