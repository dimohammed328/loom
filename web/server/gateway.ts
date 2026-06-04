/**
 * LoomGateway — async facade over the TS Loom library.
 *
 * Mirrors src/loom_web/gateway.py. Methods stay async to mirror
 * the Python interface even though the TS Loom library is synchronous.
 */

import { Loom } from "../lib/loom";
import type { Item, Project } from "../lib/items";

export class LoomGateway {
  private _root: string | undefined;
  private _loom: Loom | null = null;

  constructor(root?: string) {
    this._root = root;
  }

  get loom(): Loom {
    if (this._loom === null) {
      this._loom = this._root !== undefined ? new Loom(this._root) : new Loom();
    }
    return this._loom;
  }

  // -------------------------------------------------------------------------
  // Public async API (mirrors Python gateway)
  // -------------------------------------------------------------------------

  /** Return all projects (non-archived). */
  async listProjects(): Promise<Project[]> {
    return this.loom.projects();
  }

  /**
   * Return the full subtree rooted at *project*.
   * Throws NotFound if project does not exist.
   */
  async getTree(project: string): Promise<{ root: string; items: unknown[] }> {
    return this.loom.tree(project);
  }

  /**
   * Return a single item by qualified id.
   * Throws NotFound if not found.
   */
  async getItemDetail(qid: string): Promise<Item> {
    return this.loom.get(qid);
  }

  /**
   * Return a lightweight summary dict for *qid* (no body).
   * Throws NotFound if not found.
   */
  async getItemSummary(qid: string): Promise<{
    qid: string;
    type: string;
    title: string;
    status: string | null;
    assignee: string | null;
    branch: string | null;
    pr_url: string | null;
    tags: string[];
    archived: boolean;
  }> {
    const item = this.loom.get(qid);
    return {
      qid: item.qualifiedId,
      type: item.type,
      title: item.title,
      status: item.record.status ?? null,
      assignee: item.assignee,
      branch: item.branch,
      pr_url: item.prUrl,
      tags: [...item.tags],
      archived: item.archived,
    };
  }

  /**
   * Return the qualified ids of direct children of *qid*.
   * Returns an empty list if the item has no children.
   */
  async getChildren(qid: string): Promise<string[]> {
    try {
      const tree = this.loom.tree(qid, { depth: 1 });
      const prefix = qid + ":";
      return tree.items
        .map((i) => (i as { qid: string }).qid)
        .filter(
          (q) =>
            q !== qid &&
            q.startsWith(prefix) &&
            !q.slice(prefix.length).includes(":")
        );
    } catch {
      return [];
    }
  }
}
