/**
 * Tests for markdown body rendering helpers.
 * Covers: react-markdown + remark-gfm package availability,
 * and the renderMarkdownBody helper that renders via ReactMarkdown.
 */
import { describe, expect, test } from "bun:test";

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
