/**
 * Pure helpers for ItemModal — extracted for testability without React.
 */

import type { ItemDetail } from "../api/client";

/**
 * Split a qid string into its breadcrumb segments.
 * "proj:ab2cd:1:2" → ["proj", "ab2cd", "1", "2"]
 */
export function breadcrumbSegments(qid: string): string[] {
  return qid.split(":");
}

/**
 * Return the label for the children list section, based on item type.
 * Epic → "Stories", Story → "Tasks", Task → null (no children).
 */
export function childListLabel(item: ItemDetail): string | null {
  if (item.type === "epic") return "Stories";
  if (item.type === "story") return "Tasks";
  return null;
}

/**
 * Return the display label for a type pill.
 * Capitalises the first letter; falls back gracefully.
 */
export function typePillLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Prepare the item body content for markdown rendering.
 * Returns `{ isEmpty, content }` where `isEmpty` is true when there is
 * nothing to render, and `content` is the raw markdown string to pass
 * to ReactMarkdown.
 */
export function markdownBodyContent(body: string | null): {
  isEmpty: boolean;
  content: string;
} {
  const content = body ?? "";
  return { isEmpty: content.trim() === "", content };
}
