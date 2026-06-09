/**
 * Pure reducer for the flat items map keyed by qid.
 *
 * Used by the app store and by unit tests (no React dependency).
 */

import type { ItemNode } from "../api/client";
import type { SsePayload as WsPayload } from "../sse/client";

/** Flat map of items keyed by qid. */
export type ItemsMap = Record<string, ItemNode>;

/**
 * Build an ItemsMap from a fresh tree load.
 * Later duplicates overwrite earlier ones (last-write-wins).
 */
export function setItems(items: ItemNode[]): ItemsMap {
  const map: ItemsMap = {};
  for (const item of items) {
    map[item.qid] = item;
  }
  return map;
}

/**
 * Apply a single WS payload to the current items map.
 *
 * - Tombstone (`deleted: true`): remove the item.
 * - Otherwise: replace (or add) the item.
 *
 * Returns a new map; does NOT mutate `current`.
 */
export function applyWsPayload(current: ItemsMap, payload: WsPayload): ItemsMap {
  if (payload.deleted) {
    if (!(payload.qid in current)) return current;
    const next = { ...current };
    delete next[payload.qid];
    return next;
  }

  // Build a minimal ItemNode from the payload fields.
  // Fields absent in the payload fall back to the existing value (if any).
  const existing = current[payload.qid];
  const updated: ItemNode = {
    qid: payload.qid,
    type: payload.type ?? existing?.type ?? "task",
    title: payload.title ?? existing?.title ?? "",
    status: payload.status !== undefined ? payload.status : (existing?.status ?? null),
    assignee: payload.assignee !== undefined ? payload.assignee : (existing?.assignee ?? null),
    branch: payload.branch !== undefined ? payload.branch : (existing?.branch ?? null),
    pr_url: payload.pr_url !== undefined ? payload.pr_url : (existing?.pr_url ?? null),
    deps: existing?.deps ?? [],
    children: existing?.children ?? [],
    ...(existing?.updated_at !== undefined && { updated_at: existing.updated_at }),
  };

  return { ...current, [payload.qid]: updated };
}
