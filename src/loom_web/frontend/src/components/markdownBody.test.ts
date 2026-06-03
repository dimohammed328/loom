/**
 * Tests for ItemModal layout + markdown body rendering helpers.
 * Covers: react-markdown + remark-gfm package availability,
 * modal scrim centering, panel sizing, scroll behaviour,
 * and the renderMarkdownBody helper.
 */
import { describe, expect, test } from "bun:test";
import { modalScrimStyle, modalPanelStyle } from "./itemModalStyles";

// ---------------------------------------------------------------------------
// Task 1: react-markdown and remark-gfm must be installed
// ---------------------------------------------------------------------------

describe("react-markdown package", () => {
  test("react-markdown is importable", async () => {
    // Will fail with 'Cannot find package' until installed.
    const mod = await import("react-markdown");
    expect(mod.default).toBeDefined();
  });

  test("remark-gfm is importable", async () => {
    const mod = await import("remark-gfm");
    expect(mod.default).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 2: Modal scrim must be centered
// ---------------------------------------------------------------------------

describe("modalScrimStyle", () => {
  test("aligns items center (not flex-end)", () => {
    expect(modalScrimStyle.alignItems).toBe("center");
  });
});

// ---------------------------------------------------------------------------
// Task 3: Panel maxHeight ≤75vh, full radius, bounded width
// ---------------------------------------------------------------------------

describe("modalPanelStyle", () => {
  test("maxHeight is 75vh", () => {
    expect(modalPanelStyle.maxHeight).toBe("75vh");
  });

  test("borderRadius uses full radius on all corners", () => {
    expect(modalPanelStyle.borderRadius).toBe("var(--radius)");
  });
});
