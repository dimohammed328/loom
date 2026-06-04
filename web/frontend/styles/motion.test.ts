/**
 * Tests for motion.css primitives.
 *
 * We can't run CSS in bun:test, so we test the file contents directly:
 * verify that the key class names and at-rules are present and that
 * the prefers-reduced-motion media query suppresses them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const CSS_PATH = resolve(
  import.meta.dir,
  "motion.css",
);

let css: string;
try {
  css = readFileSync(CSS_PATH, "utf8");
} catch {
  css = "";
}

describe("motion.css exists and has content", () => {
  test("file is non-empty", () => {
    expect(css.length).toBeGreaterThan(0);
  });
});

describe("enter animation", () => {
  test("defines .loom-enter class", () => {
    expect(css).toContain(".loom-enter");
  });

  test("uses animation property for enter", () => {
    expect(css).toMatch(/animation\s*:/);
  });

  test("defines @keyframes for the enter animation", () => {
    expect(css).toMatch(/@keyframes\s+loom-enter/);
  });
});

describe("status color crossfade", () => {
  test("defines .loom-status-chip class", () => {
    expect(css).toContain(".loom-status-chip");
  });

  test("applies transition to background-color or color", () => {
    expect(css).toMatch(/transition\s*:/);
  });
});

describe("prefers-reduced-motion gate", () => {
  test("contains prefers-reduced-motion media query", () => {
    expect(css).toContain("prefers-reduced-motion");
  });

  test("suppresses animation under reduced-motion", () => {
    // The reduced-motion block must set animation to none.
    const rmBlock = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(rmBlock).toMatch(/animation\s*:\s*none/);
  });

  test("suppresses transition under reduced-motion", () => {
    const rmBlock = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(rmBlock).toMatch(/transition\s*:\s*none/);
  });
});
