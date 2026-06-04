import { describe, test, expect } from "bun:test";
import {
  QualifiedId,
  path_from_qid,
  qid_from_path,
} from "./ids";
import { InvalidQualifiedId } from "./errors";

const ROOT = "/data/loom";

// ---------------------------------------------------------------------------
// path_from_qid / qid_from_path round-trip
// ---------------------------------------------------------------------------

describe("path_from_qid / qid_from_path round-trip", () => {
  const cases: [QualifiedId, boolean][] = [
    [new QualifiedId("foo"), false],
    [new QualifiedId("foo"), true],
    [new QualifiedId("foo", "abc2345"), false],
    [new QualifiedId("foo", "abc2345"), true],
    [new QualifiedId("foo", "abc2345", 1), false],
    [new QualifiedId("foo", "abc2345", 1), true],
    [new QualifiedId("foo", "abc2345", 1, 1), false],
    [new QualifiedId("foo", "abc2345", 1, 1), true],
    [new QualifiedId("a_proj", "nmpqrst", 42, 99), false],
    [new QualifiedId("a_proj", "nmpqrst", 42, 99), true],
  ];

  for (const [qid, archived] of cases) {
    test(`round-trips ${qid} (archived=${archived})`, () => {
      const p = path_from_qid(qid, ROOT, archived);
      const [recovered, recoveredArchived] = qid_from_path(p, ROOT);
      expect(recovered).toEqual(qid);
      expect(recoveredArchived).toBe(archived);
    });
  }
});

describe("path layout specifics", () => {
  test("task path is correct", () => {
    const qid = new QualifiedId("foo", "abc2345", 2, 3);
    expect(path_from_qid(qid, ROOT)).toBe(
      "/data/loom/projects/foo/epics/abc2345/stories/2/tasks/3.md"
    );
  });

  test("archived task path is correct", () => {
    const qid = new QualifiedId("foo", "abc2345", 2, 3);
    expect(path_from_qid(qid, ROOT, true)).toBe(
      "/data/loom/_archive/projects/foo/epics/abc2345/stories/2/tasks/3.md"
    );
  });
});

describe("qid_from_path rejection cases", () => {
  test("rejects path outside root", () => {
    expect(() => qid_from_path("/elsewhere/file.md", ROOT)).toThrow(InvalidQualifiedId);
    try {
      qid_from_path("/elsewhere/file.md", ROOT);
    } catch (e) {
      expect((e as InvalidQualifiedId).message).toContain("not under root");
    }
  });

  test("rejects missing projects prefix", () => {
    expect(() => qid_from_path(`${ROOT}/stuff.md`, ROOT)).toThrow(InvalidQualifiedId);
    try {
      qid_from_path(`${ROOT}/stuff.md`, ROOT);
    } catch (e) {
      expect((e as InvalidQualifiedId).message).toContain("projects");
    }
  });

  test("rejects malformed task filename (leading zero)", () => {
    const bogus = `${ROOT}/projects/foo/epics/abc2345/stories/1/tasks/01.md`;
    expect(() => qid_from_path(bogus, ROOT)).toThrow(InvalidQualifiedId);
  });

  test("rejects unknown subdir after project", () => {
    const bogus = `${ROOT}/projects/foo/garbage/thing.md`;
    expect(() => qid_from_path(bogus, ROOT)).toThrow(InvalidQualifiedId);
    try {
      qid_from_path(bogus, ROOT);
    } catch (e) {
      expect((e as InvalidQualifiedId).message).toContain("epics");
    }
  });
});

// ---------------------------------------------------------------------------
// backlog path round-trip
// ---------------------------------------------------------------------------

describe("backlog path round-trip", () => {
  test("round-trips backlog epic", () => {
    const qid = new QualifiedId("acme", "backlog", 1, 2);
    for (const archived of [false, true]) {
      const p = path_from_qid(qid, ROOT, archived);
      const [recovered, recoveredArchived] = qid_from_path(p, ROOT);
      expect(recovered).toEqual(qid);
      expect(recoveredArchived).toBe(archived);
    }
  });

  test("project named backlog with backlog epic round-trips", () => {
    const qid = new QualifiedId("backlog", "backlog");
    const p = path_from_qid(qid, ROOT);
    const [recovered] = qid_from_path(p, ROOT);
    expect(recovered).toEqual(qid);
  });
});
