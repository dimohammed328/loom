import { describe, test, expect } from "bun:test";
import {
  LoomError,
  InvalidQualifiedId,
  ReservedName,
  NotFound,
  Duplicate,
  CycleError,
  Drift,
  ValidationError,
} from "./errors";

describe("LoomError", () => {
  test("is an Error subclass", () => {
    const e = new LoomError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(LoomError);
    expect(e.message).toBe("test");
  });
});

describe("InvalidQualifiedId", () => {
  test("is a LoomError with raw and reason attributes", () => {
    const e = new InvalidQualifiedId("bad:id", "empty segments");
    expect(e).toBeInstanceOf(LoomError);
    expect(e).toBeInstanceOf(InvalidQualifiedId);
    expect(e.raw).toBe("bad:id");
    expect(e.reason).toBe("empty segments");
    expect(e.message).toContain("bad:id");
    expect(e.message).toContain("empty segments");
  });
});

describe("ReservedName", () => {
  test("is a LoomError with name attribute", () => {
    const e = new ReservedName("projects");
    expect(e).toBeInstanceOf(LoomError);
    expect(e).toBeInstanceOf(ReservedName);
    expect(e.name_).toBe("projects");
    expect(e.message).toContain("projects");
    expect(e.message).toContain("reserved");
  });
});

describe("NotFound", () => {
  test("is a LoomError with qualifiedId attribute", () => {
    const e = new NotFound("foo:abc2345:1");
    expect(e).toBeInstanceOf(LoomError);
    expect(e).toBeInstanceOf(NotFound);
    expect(e.qualifiedId).toBe("foo:abc2345:1");
    expect(e.message).toContain("foo:abc2345:1");
  });
});

describe("Duplicate", () => {
  test("is a LoomError with qualifiedId attribute", () => {
    const e = new Duplicate("foo:abc2345:1");
    expect(e).toBeInstanceOf(LoomError);
    expect(e).toBeInstanceOf(Duplicate);
    expect(e.qualifiedId).toBe("foo:abc2345:1");
    expect(e.message).toContain("foo:abc2345:1");
  });
});

describe("CycleError", () => {
  test("is a LoomError with sourceId, targetId, cycle attributes", () => {
    const cycle = ["a", "b", "c", "a"];
    const e = new CycleError("a", "c", cycle);
    expect(e).toBeInstanceOf(LoomError);
    expect(e).toBeInstanceOf(CycleError);
    expect(e.sourceId).toBe("a");
    expect(e.targetId).toBe("c");
    expect(e.cycle).toEqual(cycle);
    expect(e.message).toContain("a");
    expect(e.message).toContain("c");
    expect(e.message).toContain("cycle");
  });
});

describe("Drift", () => {
  test("is a LoomError with qualifiedId and filePath attributes", () => {
    const e = new Drift("foo:abc2345:1", "/data/loom/projects/foo/epics/abc2345/stories/1/story.md");
    expect(e).toBeInstanceOf(LoomError);
    expect(e).toBeInstanceOf(Drift);
    expect(e.qualifiedId).toBe("foo:abc2345:1");
    expect(e.filePath).toBe("/data/loom/projects/foo/epics/abc2345/stories/1/story.md");
    expect(e.message).toContain("foo:abc2345:1");
    expect(e.message).toContain("drift");
  });
});

describe("ValidationError", () => {
  test("is a LoomError with qualifiedId (nullable) and reason attributes", () => {
    const e = new ValidationError("foo:abc2345", "missing title");
    expect(e).toBeInstanceOf(LoomError);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.qualifiedId).toBe("foo:abc2345");
    expect(e.reason).toBe("missing title");
    expect(e.message).toContain("foo:abc2345");
    expect(e.message).toContain("missing title");
  });

  test("works with null qualifiedId", () => {
    const e = new ValidationError(null, "bad YAML");
    expect(e.qualifiedId).toBeNull();
    expect(e.reason).toBe("bad YAML");
    expect(e.message).toContain("bad YAML");
    expect(e.message).not.toContain("null");
  });
});
