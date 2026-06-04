/**
 * tableRowClickHelpers — pure handler factories for TableRow click/keydown.
 *
 * Extracted into a plain .ts file so they can be unit-tested without React.
 */

/**
 * Returns a click handler that calls onOpen with the given qid.
 */
export function rowClickHandler(
  qid: string,
  onOpen: (qid: string) => void,
): () => void {
  return () => onOpen(qid);
}

/**
 * Returns a keydown handler that calls onOpen(qid) on Enter or Space,
 * preventing default scroll behaviour for Space.
 */
export function rowKeyDownHandler(
  qid: string,
  onOpen: (qid: string) => void,
): (e: Pick<KeyboardEvent, "key" | "preventDefault">) => void {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(qid);
    }
  };
}
