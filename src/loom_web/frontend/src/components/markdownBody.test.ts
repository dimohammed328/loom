/**
 * Tests for ItemModal layout + markdown body rendering helpers.
 * Covers: react-markdown + remark-gfm package availability,
 * modal scrim centering, panel sizing, scroll behaviour,
 * and the renderMarkdownBody helper.
 */
import { describe, expect, test } from "bun:test";
import { modalScrimStyle, modalPanelStyle, modalHeadStyle, modalBodyStyle } from "./itemModalStyles";

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

// ---------------------------------------------------------------------------
// Task 4: Header fixed, body scrolls internally
// ---------------------------------------------------------------------------

describe("modalHeadStyle", () => {
  test("flexShrink is 0 so header stays fixed", () => {
    expect(modalHeadStyle.flexShrink).toBe(0);
  });
});

describe("modalBodyStyle", () => {
  test("overflowY is auto so body scrolls internally", () => {
    expect(modalBodyStyle.overflowY).toBe("auto");
  });

  test("flex is 1 so body takes remaining height", () => {
    expect(modalBodyStyle.flex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 5: Render body via ReactMarkdown + remarkGfm
// ---------------------------------------------------------------------------

import { markdownBodyContent } from "./itemModalHelpers";

// ---------------------------------------------------------------------------
// Task 6: CSS for rendered markdown elements must exist
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

describe("markdown.css", () => {
  const cssPath = join(import.meta.dir, "../styles/markdown.css");

  test("file exists", () => {
    expect(() => readFileSync(cssPath, "utf8")).not.toThrow();
  });

  test("styles .markdown-body headings (h1, h2, h3)", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".markdown-body h1");
    expect(css).toContain(".markdown-body h2");
    expect(css).toContain(".markdown-body h3");
  });

  test("styles .markdown-body lists (ul, ol, li)", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".markdown-body ul");
    expect(css).toContain(".markdown-body ol");
    expect(css).toContain(".markdown-body li");
  });

  test("styles .markdown-body GFM task-list checkboxes", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain("task-list");
  });

  test("styles .markdown-body tables", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".markdown-body table");
  });

  test("styles .markdown-body code", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".markdown-body code");
  });
});

describe("markdownBodyContent", () => {
  test("returns isEmpty=true for null body", () => {
    expect(markdownBodyContent(null).isEmpty).toBe(true);
  });

  test("returns isEmpty=true for empty string body", () => {
    expect(markdownBodyContent("").isEmpty).toBe(true);
  });

  test("returns isEmpty=false for non-empty body", () => {
    expect(markdownBodyContent("# Hello").isEmpty).toBe(false);
  });

  test("returns the raw body content for rendering", () => {
    expect(markdownBodyContent("## Title\n- item").content).toBe("## Title\n- item");
  });
});
