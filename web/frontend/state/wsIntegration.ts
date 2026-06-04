/**
 * Pure helpers for WS → store + modal integration.
 *
 * Keeping these separate from the store lets us test them without React.
 */

import type { WsPayload } from "../ws/client";

/**
 * Return true when the open modal should re-fetch its detail because a WS
 * payload touches the same qid.
 *
 * Rules:
 * - No modal open → false.
 * - Tombstone (deleted) → false; the modal keeps showing the last-known
 *   detail rather than trying to fetch a deleted item.
 * - Payload qid matches openQid → true (re-fetch for fresh body/deps).
 */
export function shouldRefetchModal(
  openQid: string | null,
  payload: WsPayload,
): boolean {
  if (!openQid) return false;
  if (payload.deleted) return false;
  return payload.qid === openQid;
}
