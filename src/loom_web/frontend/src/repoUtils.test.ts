import { describe, it, expect } from "vitest";
import { repoLabel, repoHref } from "./repoUtils";

describe("repoLabel", () => {
  it("parses https url into owner/repo", () => {
    expect(repoLabel("https://github.com/acme/my-project.git")).toBe("acme/my-project");
  });

  it("parses https url without .git suffix", () => {
    expect(repoLabel("https://github.com/acme/my-project")).toBe("acme/my-project");
  });

  it("parses scp-style ssh url", () => {
    expect(repoLabel("git@github.com:acme/my-project.git")).toBe("acme/my-project");
  });

  it("parses scp-style ssh url without .git suffix", () => {
    expect(repoLabel("git@github.com:acme/my-project")).toBe("acme/my-project");
  });

  it("parses ssh:// url", () => {
    expect(repoLabel("ssh://git@github.com/acme/my-project.git")).toBe("acme/my-project");
  });

  it("returns raw string for unrecognised input", () => {
    expect(repoLabel("not-a-url")).toBe("not-a-url");
  });

  it("handles nested path — keeps only last two segments", () => {
    // Some self-hosted git servers have deep paths; we want owner/repo
    expect(repoLabel("https://gitlab.example.com/group/subgroup/repo.git")).toBe("subgroup/repo");
  });
});

describe("repoHref", () => {
  it("returns https github url from https input", () => {
    expect(repoHref("https://github.com/acme/my-project.git")).toBe("https://github.com/acme/my-project");
  });

  it("returns https github url from scp ssh input", () => {
    expect(repoHref("git@github.com:acme/my-project.git")).toBe("https://github.com/acme/my-project");
  });

  it("returns null for unrecognised input", () => {
    expect(repoHref("not-a-url")).toBeNull();
  });
});
