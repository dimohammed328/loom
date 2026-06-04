import { describe, expect, test, mock } from "bun:test";
import { rowClickHandler, rowKeyDownHandler } from "./tableRowClickHelpers";

/**
 * Tests for the row-click → modal open wiring.
 *
 * The click handler on a TableRow must:
 *  1. Call onOpen(qid) when the row is clicked.
 *  2. Call onOpen(qid) when Enter or Space is pressed on the row.
 *  3. NOT call onOpen when other keys (e.g. Tab, ArrowDown) are pressed.
 *  4. NOT call onOpen when a chevron button click propagates (stopPropagation
 *     is the chevron's responsibility; the handler receives the row event).
 */

describe("rowClickHandler", () => {
  test("calls onOpen with the row qid", () => {
    const onOpen = mock(() => { /* no-op */ });
    const handler = rowClickHandler("proj:aaa23:1", onOpen);
    handler();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("proj:aaa23:1");
  });

  test("calls onOpen with the exact qid passed in", () => {
    const onOpen = mock(() => { /* no-op */ });
    const qid = "proj:bbb23:2:3";
    rowClickHandler(qid, onOpen)();
    expect(onOpen).toHaveBeenCalledWith(qid);
  });
});

describe("rowKeyDownHandler", () => {
  test("calls onOpen when Enter is pressed", () => {
    const onOpen = mock(() => { /* no-op */ });
    const preventDefault = mock(() => { /* no-op */ });
    rowKeyDownHandler("proj:aaa23:1", onOpen)({ key: "Enter", preventDefault } as unknown as KeyboardEvent);
    expect(onOpen).toHaveBeenCalledWith("proj:aaa23:1");
    expect(preventDefault).toHaveBeenCalled();
  });

  test("calls onOpen when Space is pressed", () => {
    const onOpen = mock(() => { /* no-op */ });
    const preventDefault = mock(() => { /* no-op */ });
    rowKeyDownHandler("proj:aaa23:1", onOpen)({ key: " ", preventDefault } as unknown as KeyboardEvent);
    expect(onOpen).toHaveBeenCalledWith("proj:aaa23:1");
    expect(preventDefault).toHaveBeenCalled();
  });

  test("does NOT call onOpen for Tab", () => {
    const onOpen = mock(() => { /* no-op */ });
    const preventDefault = mock(() => { /* no-op */ });
    rowKeyDownHandler("proj:aaa23:1", onOpen)({ key: "Tab", preventDefault } as unknown as KeyboardEvent);
    expect(onOpen).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test("does NOT call onOpen for ArrowDown", () => {
    const onOpen = mock(() => { /* no-op */ });
    const preventDefault = mock(() => { /* no-op */ });
    rowKeyDownHandler("proj:aaa23:1", onOpen)({ key: "ArrowDown", preventDefault } as unknown as KeyboardEvent);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
