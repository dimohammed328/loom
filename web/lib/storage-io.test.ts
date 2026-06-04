import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { load, dump, atomicWriteText, bodyHash } from "./storage";
import { ValidationError } from "./errors";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-storage-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// atomicWriteText
// ---------------------------------------------------------------------------

describe("atomicWriteText", () => {
  test("writes content to file", () => {
    const p = path.join(tmpDir, "out.md");
    atomicWriteText(p, "hello\n");
    expect(fs.readFileSync(p, "utf-8")).toBe("hello\n");
  });

  test("creates parent directories", () => {
    const p = path.join(tmpDir, "deep", "nested", "out.md");
    atomicWriteText(p, "content\n");
    expect(fs.readFileSync(p, "utf-8")).toBe("content\n");
  });

  test("overwrites existing file atomically", () => {
    const p = path.join(tmpDir, "out.md");
    atomicWriteText(p, "first\n");
    atomicWriteText(p, "second\n");
    expect(fs.readFileSync(p, "utf-8")).toBe("second\n");
  });

  test("leaves no temp files behind", () => {
    const p = path.join(tmpDir, "out.md");
    atomicWriteText(p, "data\n");
    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(["out.md"]);
  });
});

// ---------------------------------------------------------------------------
// load / dump
// ---------------------------------------------------------------------------

describe("load", () => {
  test("reads frontmatter and body from file", () => {
    const p = path.join(tmpDir, "item.md");
    fs.writeFileSync(p, "---\ntitle: Test\nstatus: ready\n---\n## Body\n", "utf-8");
    const [fm, body] = load(p);
    expect(fm).toEqual({ title: "Test", status: "ready" });
    expect(body).toBe("## Body\n");
  });

  test("raises ValidationError on unclosed fence", () => {
    const p = path.join(tmpDir, "bad.md");
    fs.writeFileSync(p, "---\ntitle: T\n", "utf-8");
    expect(() => load(p)).toThrow(ValidationError);
  });
});

describe("dump", () => {
  test("writes frontmatter + body atomically", () => {
    const p = path.join(tmpDir, "item.md");
    dump(p, { title: "Hello", status: "ready" }, "## Body\n");
    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("title: Hello");
    expect(content).toContain("## Body");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("load(dump(fm, body)) round-trips", () => {
    const p = path.join(tmpDir, "item.md");
    const fm = { title: "RT", status: "in_progress", assignee: "ses:ag" };
    const body = "## Summary\n\nSome content.\n";
    dump(p, fm, body);
    const [recoveredFm, recoveredBody] = load(p);
    expect(recoveredFm).toEqual(fm);
    expect(recoveredBody).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// bodyHash
// ---------------------------------------------------------------------------

describe("bodyHash", () => {
  test("returns a 64-char hex sha256 digest", async () => {
    const p = path.join(tmpDir, "item.md");
    fs.writeFileSync(p, "---\ntitle: T\n---\nbody\n", "utf-8");
    const hash = await bodyHash(p);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hash is of raw on-disk bytes (stable)", async () => {
    const p = path.join(tmpDir, "item.md");
    const content = "---\ntitle: T\n---\nbody\n";
    fs.writeFileSync(p, content, "utf-8");
    const hash1 = await bodyHash(p);
    const hash2 = await bodyHash(p);
    expect(hash1).toBe(hash2);
  });

  test("different content yields different hash", async () => {
    const p1 = path.join(tmpDir, "a.md");
    const p2 = path.join(tmpDir, "b.md");
    fs.writeFileSync(p1, "---\ntitle: A\n---\nbody\n", "utf-8");
    fs.writeFileSync(p2, "---\ntitle: B\n---\nbody\n", "utf-8");
    const h1 = await bodyHash(p1);
    const h2 = await bodyHash(p2);
    expect(h1).not.toBe(h2);
  });
});
