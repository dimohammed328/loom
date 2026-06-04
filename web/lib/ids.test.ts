import { describe, test, expect } from "bun:test";
import {
  QualifiedId,
  ItemType,
  parse_qid,
  validate_project_name,
  random_epic_id,
  EPIC_ALPHABET,
  EPIC_ID_LEN,
} from "./ids";
import { InvalidQualifiedId, ReservedName } from "./errors";

// ---------------------------------------------------------------------------
// parse_qid — happy paths
// ---------------------------------------------------------------------------

describe("parse_qid happy paths", () => {
  test.each([
    ["foo", new QualifiedId("foo")],
    ["foo:abc2345", new QualifiedId("foo", "abc2345")],
    ["foo:abc2345:1", new QualifiedId("foo", "abc2345", 1)],
    ["foo:abc2345:1:1", new QualifiedId("foo", "abc2345", 1, 1)],
    ["a_proj:nmpqrst:42:99", new QualifiedId("a_proj", "nmpqrst", 42, 99)],
  ])("round-trips %s", (raw, expected) => {
    const qid = parse_qid(raw);
    expect(qid).toEqual(expected);
    expect(qid.toString()).toBe(raw);
  });
});

describe("ItemType inference", () => {
  test("project", () => expect(parse_qid("foo").type).toBe(ItemType.PROJECT));
  test("epic", () => expect(parse_qid("foo:abc2345").type).toBe(ItemType.EPIC));
  test("story", () => expect(parse_qid("foo:abc2345:1").type).toBe(ItemType.STORY));
  test("task", () => expect(parse_qid("foo:abc2345:1:1").type).toBe(ItemType.TASK));
});

describe("parent chain", () => {
  test("traverses correctly", () => {
    const task = parse_qid("foo:abc2345:1:2");
    const story = task.parent;
    const epic = story!.parent;
    const project = epic!.parent;
    expect(story).toEqual(new QualifiedId("foo", "abc2345", 1));
    expect(epic).toEqual(new QualifiedId("foo", "abc2345"));
    expect(project).toEqual(new QualifiedId("foo"));
    expect(project!.parent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parse_qid — rejection cases
// ---------------------------------------------------------------------------

describe("parse_qid structural rejects", () => {
  test.each([
    ["", "empty segments"],
    [":foo", "empty segments"],
    ["foo:", "empty segments"],
    ["foo::1", "empty segments"],
    ["foo:abc2345:1:1:extra", "1-4"],
    ["foo bar", "whitespace"],
    ["foo:abc2345 ", "whitespace"],
    [" foo", "whitespace"],
  ])("rejects %j with reason containing %j", (raw, reasonSubstr) => {
    expect(() => parse_qid(raw)).toThrow(InvalidQualifiedId);
    try {
      parse_qid(raw);
    } catch (e) {
      expect((e as InvalidQualifiedId).reason).toContain(reasonSubstr);
    }
  });
});

describe("parse_qid invalid project format", () => {
  test.each(["Foo", "1foo", "-foo", "foo.bar"])(
    "rejects %s",
    (raw) => expect(() => parse_qid(raw)).toThrow(InvalidQualifiedId)
  );
});

describe("parse_qid accepts hyphen and underscore in project", () => {
  test("acme-v2", () => expect(parse_qid("acme-v2").project).toBe("acme-v2"));
  test("acme_v2", () => expect(parse_qid("acme_v2").project).toBe("acme_v2"));
  test("a-b-c", () => expect(parse_qid("a-b-c").project).toBe("a-b-c"));
});

describe("parse_qid reserved project names", () => {
  test.each(["projects", "loom", "_archive", "_anything"])(
    "rejects %s",
    (name) => expect(() => parse_qid(name)).toThrow(ReservedName)
  );
});

describe("parse_qid epic id constraints", () => {
  test("rejects uppercase", () => expect(() => parse_qid("foo:ABC1234")).toThrow(InvalidQualifiedId));
  test("rejects hyphen in epic", () => expect(() => parse_qid("foo:abc-234")).toThrow(InvalidQualifiedId));
  test("rejects too short", () => expect(() => parse_qid("foo:abc12")).toThrow(InvalidQualifiedId));
  test("rejects too long", () => expect(() => parse_qid("foo:abc23455")).toThrow(InvalidQualifiedId));
  test("rejects excluded char o", () => expect(() => parse_qid("foo:abc123o")).toThrow(InvalidQualifiedId));
});

describe("parse_qid story index rejects", () => {
  test.each(["01", "0", "-1", "+1", "1.0", "abc", "1e3"])(
    "rejects story index %s",
    (bad) => expect(() => parse_qid(`foo:abc2345:${bad}`)).toThrow(InvalidQualifiedId)
  );
});

describe("parse_qid task index rejects", () => {
  test.each(["01", "0", "-1", "+1", "abc"])(
    "rejects task index %s",
    (bad) => expect(() => parse_qid(`foo:abc2345:1:${bad}`)).toThrow(InvalidQualifiedId)
  );
});

describe("validate_project_name", () => {
  test("rejects name too long", () => {
    expect(() => validate_project_name("a".repeat(65))).toThrow(InvalidQualifiedId);
  });
  test("accepts max-length name (64 chars)", () => {
    expect(() => validate_project_name("a".repeat(64))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// random_epic_id
// ---------------------------------------------------------------------------

describe("random_epic_id", () => {
  test("uses only alphabet chars and has correct length", () => {
    const alphabet = new Set(EPIC_ALPHABET);
    for (let i = 0; i < 200; i++) {
      const eid = random_epic_id();
      expect(eid.length).toBe(EPIC_ID_LEN);
      for (const ch of eid) expect(alphabet.has(ch)).toBe(true);
    }
  });

  test("round-trips through parse_qid", () => {
    for (let i = 0; i < 50; i++) {
      const eid = random_epic_id();
      expect(parse_qid(`foo:${eid}`).epic).toBe(eid);
    }
  });
});

// ---------------------------------------------------------------------------
// backlog epic id
// ---------------------------------------------------------------------------

describe("backlog epic id", () => {
  test("parse_qid accepts backlog literal", () => {
    const qid = parse_qid("acme:backlog");
    expect(qid).toEqual(new QualifiedId("acme", "backlog"));
    expect(qid.toString()).toBe("acme:backlog");
    expect(qid.type).toBe(ItemType.EPIC);
  });

  test("backlog under story and task", () => {
    expect(parse_qid("acme:backlog:1").epic).toBe("backlog");
    expect(parse_qid("acme:backlog:1:2").epic).toBe("backlog");
  });

  test("backlog is case-sensitive", () => {
    expect(() => parse_qid("acme:Backlog")).toThrow(InvalidQualifiedId);
    expect(() => parse_qid("acme:BACKLOG")).toThrow(InvalidQualifiedId);
  });

  test("backlog prefix still rejects", () => {
    expect(() => parse_qid("acme:backlogx")).toThrow(InvalidQualifiedId);
  });

  test("project named backlog round-trips", () => {
    const qid = new QualifiedId("backlog", "backlog");
    expect(qid.toString()).toBe("backlog:backlog");
    expect(parse_qid("backlog:backlog").toString()).toBe("backlog:backlog");
  });
});
