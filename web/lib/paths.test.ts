import { describe, test, expect } from "bun:test";
import * as os from "os";
import * as path from "path";
import { loomRoot } from "./paths";

describe("loomRoot", () => {
  test("LOOM_DIR takes precedence over everything", () => {
    const env = {
      LOOM_DIR: "/explicit/loom",
      XDG_DATA_HOME: "/xdg/data",
    };
    expect(loomRoot(env)).toBe("/explicit/loom");
  });

  test("XDG_DATA_HOME/loom when LOOM_DIR not set", () => {
    const env = { XDG_DATA_HOME: "/xdg/data" };
    expect(loomRoot(env)).toBe("/xdg/data/loom");
  });

  test("~/.local/share/loom when neither set", () => {
    const result = loomRoot({});
    expect(result).toBe(path.join(os.homedir(), ".local", "share", "loom"));
  });

  test("tilde expansion in LOOM_DIR", () => {
    const env = { LOOM_DIR: "~/custom/loom" };
    expect(loomRoot(env)).toBe(path.join(os.homedir(), "custom", "loom"));
  });

  test("tilde expansion in XDG_DATA_HOME", () => {
    const env = { XDG_DATA_HOME: "~/xdg" };
    expect(loomRoot(env)).toBe(path.join(os.homedir(), "xdg", "loom"));
  });

  test("uses real process.env when no env passed", () => {
    const origLoomDir = process.env["LOOM_DIR"];
    const origXdg = process.env["XDG_DATA_HOME"];
    try {
      process.env["LOOM_DIR"] = "/tmp/from-real-env";
      delete process.env["XDG_DATA_HOME"];
      expect(loomRoot()).toBe("/tmp/from-real-env");
    } finally {
      if (origLoomDir !== undefined) process.env["LOOM_DIR"] = origLoomDir;
      else delete process.env["LOOM_DIR"];
      if (origXdg !== undefined) process.env["XDG_DATA_HOME"] = origXdg;
    }
  });
});
