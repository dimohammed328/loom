import { describe, expect, test } from "bun:test";
import { statusColor, FALLBACK_COLORS, KNOWN_STATUSES } from "./status";

describe("statusColor", () => {
  test("ready returns ready palette tokens", () => {
    const c = statusColor("ready");
    expect(c.dot).toBe("var(--st-ready-dot)");
    expect(c.fg).toBe("var(--st-ready-fg)");
    expect(c.bg).toBe("var(--st-ready-bg)");
  });

  test("in progress returns progress palette tokens", () => {
    const c = statusColor("in progress");
    expect(c.dot).toBe("var(--st-progress-dot)");
    expect(c.fg).toBe("var(--st-progress-fg)");
    expect(c.bg).toBe("var(--st-progress-bg)");
  });

  test("in review returns review palette tokens", () => {
    const c = statusColor("in review");
    expect(c.dot).toBe("var(--st-review-dot)");
    expect(c.fg).toBe("var(--st-review-fg)");
    expect(c.bg).toBe("var(--st-review-bg)");
  });

  test("blocked returns blocked palette tokens", () => {
    const c = statusColor("blocked");
    expect(c.dot).toBe("var(--st-blocked-dot)");
    expect(c.fg).toBe("var(--st-blocked-fg)");
    expect(c.bg).toBe("var(--st-blocked-bg)");
  });

  test("done returns done palette tokens", () => {
    const c = statusColor("done");
    expect(c.dot).toBe("var(--st-done-dot)");
    expect(c.fg).toBe("var(--st-done-fg)");
    expect(c.bg).toBe("var(--st-done-bg)");
  });

  test("unknown string returns neutral fallback", () => {
    expect(statusColor("completed")).toEqual(FALLBACK_COLORS);
    expect(statusColor("wontfix")).toEqual(FALLBACK_COLORS);
    expect(statusColor("custom-status")).toEqual(FALLBACK_COLORS);
  });

  test("null returns neutral fallback", () => {
    expect(statusColor(null)).toEqual(FALLBACK_COLORS);
  });

  test("undefined returns neutral fallback", () => {
    expect(statusColor(undefined)).toEqual(FALLBACK_COLORS);
  });

  test("empty string returns neutral fallback", () => {
    expect(statusColor("")).toEqual(FALLBACK_COLORS);
  });

  test("case-insensitive matching for known statuses", () => {
    expect(statusColor("Ready")).toEqual(statusColor("ready"));
    expect(statusColor("DONE")).toEqual(statusColor("done"));
    expect(statusColor("In Progress")).toEqual(statusColor("in progress"));
  });

  test("KNOWN_STATUSES contains all five canonical statuses", () => {
    const expected = ["ready", "in progress", "in review", "blocked", "done"];
    for (const s of expected) {
      expect(KNOWN_STATUSES).toContain(s);
    }
    expect(KNOWN_STATUSES.length).toBe(5);
  });

  test("FALLBACK_COLORS uses neutral CSS variables", () => {
    expect(FALLBACK_COLORS.dot).toBe("var(--text-3)");
    expect(FALLBACK_COLORS.fg).toBe("var(--text-2)");
    expect(FALLBACK_COLORS.bg).toBe("var(--surface-2)");
  });
});
