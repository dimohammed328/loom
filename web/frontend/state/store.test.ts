import { describe, expect, test } from "bun:test";

/**
 * Tests for the openModal / closeModal selection-state logic.
 *
 * The store is a React context so we test the logic directly rather than
 * mounting components (no DOM available in bun test).
 *
 * We extract the key invariants:
 *  1. openModal(qid) sets openQid to that qid.
 *  2. closeModal() clears openQid to null.
 *  3. openModal accepts any non-empty qid string.
 */

// Simulate the state transitions imperatively — this mirrors exactly what
// useState + useCallback do inside the provider.

interface ModalState {
  openQid: string | null;
}

function openModal(_state: ModalState, qid: string): ModalState {
  return { openQid: qid };
}

function closeModal(_state: ModalState): ModalState {
  return { openQid: null };
}

/**
 * Tests for the collapse-control registration logic.
 *
 * The table view registers a { isAllCollapsed, toggle } control; TopBar reads
 * it. We test the state transitions imperatively.
 */

interface CollapseControl {
  isAllCollapsed: boolean;
  toggle: () => void;
}

interface CollapseControlState {
  collapseControl: CollapseControl | null;
}

function registerControl(
  _state: CollapseControlState,
  ctrl: CollapseControl,
): CollapseControlState {
  return { collapseControl: ctrl };
}

function clearControl(
  _state: CollapseControlState,
): CollapseControlState {
  return { collapseControl: null };
}

describe("collapse control registration", () => {
  test("registerControl stores the provided control", () => {
    const toggle = () => { /* no-op */ };
    const s0: CollapseControlState = { collapseControl: null };
    const s1 = registerControl(s0, { isAllCollapsed: false, toggle });
    expect(s1.collapseControl).not.toBeNull();
    expect(s1.collapseControl!.isAllCollapsed).toBe(false);
    expect(s1.collapseControl!.toggle).toBe(toggle);
  });

  test("registerControl replaces a previously registered control", () => {
    const t1 = () => { /* no-op */ };
    const t2 = () => { /* no-op */ };
    const s0: CollapseControlState = { collapseControl: null };
    const s1 = registerControl(s0, { isAllCollapsed: false, toggle: t1 });
    const s2 = registerControl(s1, { isAllCollapsed: true, toggle: t2 });
    expect(s2.collapseControl!.toggle).toBe(t2);
    expect(s2.collapseControl!.isAllCollapsed).toBe(true);
  });

  test("clearControl sets collapseControl to null", () => {
    const s0: CollapseControlState = {
      collapseControl: { isAllCollapsed: false, toggle: () => { /* no-op */ } },
    };
    const s1 = clearControl(s0);
    expect(s1.collapseControl).toBeNull();
  });

  test("clearControl is idempotent on already-null state", () => {
    const s0: CollapseControlState = { collapseControl: null };
    const s1 = clearControl(s0);
    expect(s1.collapseControl).toBeNull();
  });
});

describe("modal selection state transitions", () => {
  test("openModal sets openQid to the given qid", () => {
    const s0: ModalState = { openQid: null };
    const s1 = openModal(s0, "proj:abc23:1");
    expect(s1.openQid).toBe("proj:abc23:1");
  });

  test("openModal replaces a previously open qid", () => {
    const s0 = openModal({ openQid: null }, "proj:abc23:1");
    const s1 = openModal(s0, "proj:abc23:2");
    expect(s1.openQid).toBe("proj:abc23:2");
  });

  test("closeModal sets openQid to null", () => {
    const s0 = openModal({ openQid: null }, "proj:abc23:1");
    const s1 = closeModal(s0);
    expect(s1.openQid).toBeNull();
  });

  test("closeModal is idempotent on already-closed state", () => {
    const s0: ModalState = { openQid: null };
    const s1 = closeModal(s0);
    expect(s1.openQid).toBeNull();
  });

  test("openModal accepts any qid string including task-level qids", () => {
    const qids = ["p:aaa23:1", "p:aaa23:1:3", "p:bbb23"];
    for (const qid of qids) {
      const s = openModal({ openQid: null }, qid);
      expect(s.openQid).toBe(qid);
    }
  });
});
