/**
 * Additional storage tests porting Python test_storage.py cases not yet
 * covered by storage.test.ts and storage-io.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parse, render, dump, load } from "./storage";
import { ValidationError } from "./errors";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-storage-extra-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parse edge cases
// ---------------------------------------------------------------------------

describe("parse edge cases", () => {
  test("empty frontmatter block (--- / ---) returns empty fm", () => {
    const text = "---\n---\nbody\n";
    const [fm, body] = parse(text);
    expect(fm).toEqual({});
    expect(body).toBe("body\n");
  });

  test("non-mapping frontmatter raises ValidationError", () => {
    const text = "---\n- just\n- a\n- list\n---\nbody\n";
    expect(() => parse(text)).toThrow(ValidationError);
    try { parse(text); } catch (e) {
      expect((e as ValidationError).message).toContain("mapping");
    }
  });

  test("preserves unknown/nested keys", () => {
    const text = "---\ntitle: t\nweird_key: 42\nnested:\n  a: 1\n  b:\n    - x\n    - y\n---\nbody\n";
    const [fm] = parse(text);
    expect(fm["weird_key"]).toBe(42);
    expect((fm["nested"] as Record<string, unknown>)["a"]).toBe(1);
    expect((fm["nested"] as Record<string, unknown>)["b"]).toEqual(["x", "y"]);
  });
});

// ---------------------------------------------------------------------------
// render edge cases
// ---------------------------------------------------------------------------

describe("render edge cases", () => {
  test("render normalizes multiple trailing newlines", () => {
    const text = render({ a: 1 }, "body\n\n\n\n");
    expect(text.endsWith("body\n")).toBe(true);
    expect(text.endsWith("body\n\n")).toBe(false);
  });

  test("render adds trailing newline when body has none", () => {
    const text = render({ a: 1 }, "no newline at end");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("render empty body produces exact output", () => {
    const text = render({ a: 1 }, "");
    expect(text).toBe("---\na: 1\n---\n");
  });

  test("render with no frontmatter returns body unchanged", () => {
    expect(render({}, "just body\n")).toBe("just body\n");
  });
});

// ---------------------------------------------------------------------------
// complex dump / load round-trips
// ---------------------------------------------------------------------------

describe("complex dump/load round-trips", () => {
  test("complex nested fm survives disk round-trip", () => {
    const p = path.join(tmpDir, "item.md");
    const fm: Record<string, unknown> = {
      schema_version: 1,
      title: "OAuth backend",
      tags: ["auth", "security"],
      depends_on: ["foo:abcdefg:1"],
      custom: { score: 3, extra: ["a", "b"] },
    };
    const body = "## Context\n\nSome body content with --- inside it.\n";
    dump(p, fm, body);
    const [fm2, body2] = load(p);
    expect(fm2["schema_version"]).toBe(1);
    expect(fm2["title"]).toBe("OAuth backend");
    expect(fm2["tags"]).toEqual(["auth", "security"]);
    expect(fm2["depends_on"]).toEqual(["foo:abcdefg:1"]);
    expect(Object.keys(fm2["custom"] as object)).toEqual(["score", "extra"]);
    expect(body2).toBe(body);
  });

  test("key order preserved through disk round-trip", () => {
    const p = path.join(tmpDir, "item.md");
    const fm: Record<string, unknown> = { z: 1, a: 2, m: 3 };
    dump(p, fm, "body\n");
    const [fm2] = load(p);
    expect(Object.keys(fm2)).toEqual(["z", "a", "m"]);
  });

  test("literal block string survives round-trip", () => {
    const text =
      "---\ntitle: t\ndescription: |\n  line one\n  line two\n  line three\n---\nbody\n";
    const [fm, body] = parse(text);
    expect(fm["description"]).toBe("line one\nline two\nline three\n");
    const p = path.join(tmpDir, "item.md");
    dump(p, fm, body);
    const [fm2, body2] = load(p);
    expect(fm2["description"]).toBe("line one\nline two\nline three\n");
    expect(body2).toBe(body);
  });
});
