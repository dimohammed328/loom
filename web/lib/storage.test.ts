import { describe, test, expect } from "bun:test";
import { parse, render } from "./storage";
import { ValidationError } from "./errors";

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe("parse", () => {
  test("parses frontmatter and body", () => {
    const text = "---\ntitle: Hello\nstatus: ready\n---\n## Body\n";
    const [fm, body] = parse(text);
    expect(fm).toEqual({ title: "Hello", status: "ready" });
    expect(body).toBe("## Body\n");
  });

  test("empty body after closing fence", () => {
    const text = "---\ntitle: T\n---\n";
    const [fm, body] = parse(text);
    expect(fm).toEqual({ title: "T" });
    expect(body).toBe("");
  });

  test("no frontmatter fence returns empty fm and whole text as body", () => {
    const text = "just a body\n";
    const [fm, body] = parse(text);
    expect(fm).toEqual({});
    expect(body).toBe("just a body\n");
  });

  test("empty file returns empty fm and empty body", () => {
    const [fm, body] = parse("");
    expect(fm).toEqual({});
    expect(body).toBe("");
  });

  test("unclosed fence raises ValidationError", () => {
    const text = "---\ntitle: T\n";
    expect(() => parse(text)).toThrow(ValidationError);
  });

  test("unclosed fence includes source in message", () => {
    const text = "---\ntitle: T\n";
    expect(() => parse(text, "myfile.md")).toThrow(/myfile\.md/);
  });

  test("garbled YAML raises ValidationError", () => {
    const text = "---\n: bad: yaml: [\n---\nbody\n";
    expect(() => parse(text)).toThrow(ValidationError);
  });

  test("garbled YAML includes source in message", () => {
    const text = "---\n: bad: yaml: [\n---\nbody\n";
    expect(() => parse(text, "src.md")).toThrow(/src\.md/);
  });

  test("preserves key insertion order", () => {
    const text = "---\nz_key: 1\na_key: 2\nm_key: 3\n---\n";
    const [fm] = parse(text);
    expect(Object.keys(fm)).toEqual(["z_key", "a_key", "m_key"]);
  });

  test("body with horizontal rule (---) does not confuse parser", () => {
    const text = "---\ntitle: T\n---\n## Section\n\n---\n\nmore text\n";
    const [fm, body] = parse(text);
    expect(fm).toEqual({ title: "T" });
    expect(body).toContain("---");
    expect(body).toContain("more text");
  });
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

describe("render", () => {
  test("renders frontmatter + body", () => {
    const result = render({ title: "Hello", status: "ready" }, "## Body\n");
    expect(result).toContain("---\n");
    expect(result).toContain("title: Hello");
    expect(result).toContain("status: ready");
    expect(result).toContain("## Body");
  });

  test("output ends with exactly one trailing newline", () => {
    const result = render({ title: "T" }, "body text");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
  });

  test("empty frontmatter omits fence", () => {
    const result = render({}, "just body\n");
    expect(result).not.toContain("---");
    expect(result).toContain("just body");
  });

  test("empty body with frontmatter still ends with one newline", () => {
    const result = render({ title: "T" }, "");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
  });

  test("preserves key order in output", () => {
    const fm: Record<string, unknown> = {};
    fm["z_key"] = 1;
    fm["a_key"] = 2;
    fm["m_key"] = 3;
    const result = render(fm, "");
    const zIdx = result.indexOf("z_key");
    const aIdx = result.indexOf("a_key");
    const mIdx = result.indexOf("m_key");
    expect(zIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(mIdx);
  });
});

// ---------------------------------------------------------------------------
// parse/render round-trip
// ---------------------------------------------------------------------------

describe("parse/render round-trip", () => {
  test("round-trips byte-stably", () => {
    const original = "---\ntitle: Hello World\nstatus: in_progress\nassignee: ses:agent\n---\n## Summary\n\nSome body text.\n";
    const [fm, body] = parse(original);
    const rendered = render(fm, body);
    expect(rendered).toBe(original);
  });

  test("round-trips with null/undefined values omitted", () => {
    const text = "---\ntitle: T\nstatus: ready\n---\n";
    const [fm, body] = parse(text);
    const rendered = render(fm, body);
    expect(rendered).toBe(text);
  });
});
