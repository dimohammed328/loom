import { describe, test, expect } from "bun:test";
import { greet } from "./smoke";

describe("smoke", () => {
  test("greet returns a greeting string", () => {
    expect(greet("world")).toBe("hello, world");
  });
});
