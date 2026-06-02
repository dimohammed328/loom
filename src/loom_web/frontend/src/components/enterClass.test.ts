/**
 * Tests for the enterClass helper.
 *
 * enterClass(base, isNew) returns the base class alone when isNew is falsy,
 * and appends " loom-enter" when isNew is true.
 */

import { describe, expect, test } from "bun:test";
import { enterClass } from "./enterClass";

describe("enterClass", () => {
  test("returns base class when isNew is false", () => {
    expect(enterClass("kcard", false)).toBe("kcard");
  });

  test("returns base class when isNew is undefined", () => {
    expect(enterClass("kcard", undefined)).toBe("kcard");
  });

  test("appends loom-enter when isNew is true", () => {
    expect(enterClass("kcard", true)).toBe("kcard loom-enter");
  });

  test("works with any base class string", () => {
    expect(enterClass("trow", true)).toBe("trow loom-enter");
    expect(enterClass("snode", true)).toBe("snode loom-enter");
  });

  test("works with empty base class", () => {
    expect(enterClass("", true)).toBe(" loom-enter");
    expect(enterClass("", false)).toBe("");
  });
});
