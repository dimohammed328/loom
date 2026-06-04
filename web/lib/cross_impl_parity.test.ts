/**
 * Cross-implementation parity tests.
 *
 * Direction 1: TS library creates a tree → `uv run loom validate` must pass.
 * Direction 2: Python CLI creates items → TS lib reads them; fields must match.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { Loom } from "./loom";
import { initDb, DB_FILENAME } from "./index";
import { rebuild } from "./rebuild";
import { computeDependencies } from "./deps";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-parity-"));
  initDb(path.join(dir, DB_FILENAME));
  return dir;
}

/**
 * Run a shell command synchronously from the repo root.
 * Returns { stdout, stderr, status }.
 */
function runCmd(cmd: string[], env?: Record<string, string>): { stdout: string; stderr: string; status: number } {
  // Find repo root — three levels up from web/lib/
  const repoRoot = path.resolve(__dirname, "..", "..");
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Direction 1: TS-authored tree passes `uv run loom validate`
// ---------------------------------------------------------------------------

describe("parity: TS-authored items pass Python loom validate", () => {
  test("project/epic/story/task created by TS lib pass loom validate with no issues", async () => {
    const loomDir = makeTmpDir();
    const loom = new Loom(loomDir);

    const project = await loom.createProject("parity", {
      title: "Parity Project",
      repo: "https://github.com/example/parity",
      defaultBranch: "main",
    });
    const epic = await project.createEpic({ title: "Parity Epic", epicId: "aaaaaaa" });
    const story = await epic.createStory({ title: "Parity Story", body: "Story body." });
    const task1 = await story.createTask({ title: "Task one", body: "First task." });
    const task2 = await story.createTask({ title: "Task two", body: "Second task." });
    await task2.dependsOn(task1.qualifiedId);

    // Run Python loom validate against the TS-authored directory.
    const result = runCmd(
      ["uv", "run", "loom", "validate", "--root", loomDir, "--json"],
    );
    expect(result.status).toBe(0);
    const issues: unknown[] = JSON.parse(result.stdout.trim() || "[]");
    expect(issues).toEqual([]);
  });

  test("tags added by TS lib survive loom validate", async () => {
    const loomDir = makeTmpDir();
    const loom = new Loom(loomDir);

    const project = await loom.createProject("tagtest", { title: "Tag Test" });
    const epic = await project.createEpic({ title: "Epic", epicId: "bbbbbbb" });
    const story = await epic.createStory({ title: "Story" });
    const task = await story.createTask({ title: "Tagged Task" });
    task.addTag("urgent");
    task.refresh().addTag("p1");

    const result = runCmd(
      ["uv", "run", "loom", "validate", "--root", loomDir, "--json"],
    );
    expect(result.status).toBe(0);
    const issues: unknown[] = JSON.parse(result.stdout.trim() || "[]");
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direction 2: Python-authored items read identically by TS lib
// ---------------------------------------------------------------------------

describe("parity: Python-authored items read correctly by TS lib", () => {
  test("project/epic/story/task created by Python CLI are read by TS Loom with matching fields", async () => {
    const loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-py-parity-"));

    // Bootstrap the loom dir via Python CLI.
    // Note: --root is a per-subcommand flag (not global), placed after the subcommand name.
    const init = runCmd(["uv", "run", "loom", "init", "--root", loomDir]);
    expect(init.status).toBe(0);

    // Stamp TS schema version on the Python-created DB so new Loom() can open it.
    // initDb is idempotent and only sets user_version; it does not alter data tables.
    initDb(path.join(loomDir, DB_FILENAME));

    // Create project
    const createProject = runCmd([
      "uv", "run", "loom", "-y",
      "project", "create", "--root", loomDir,
      "--title", "Python Project", "--repo", "https://github.com/example/py", "py",
    ]);
    expect(createProject.status).toBe(0);

    // Create epic
    const createEpic = runCmd([
      "uv", "run", "loom", "-y",
      "epic", "create", "--root", loomDir,
      "--title", "Python Epic", "py",
    ]);
    expect(createEpic.status).toBe(0);

    // Get the epic qid from loom tree
    const listResult = runCmd([
      "uv", "run", "loom",
      "tree", "--root", loomDir, "--json", "py",
    ]);
    expect(listResult.status).toBe(0);
    const { items: tree }: { items: Array<{ qid: string; type: string }> } = JSON.parse(listResult.stdout.trim());
    const epicItem = tree.find((item) => item.type === "epic" && item.qid !== "py:backlog");
    expect(epicItem).toBeDefined();
    const epicQid = epicItem!.qid;

    // Create story under the epic
    const createStory = runCmd([
      "uv", "run", "loom", "-y",
      "story", "create", "--root", loomDir,
      "--title", "Python Story", "--body", "Story from Python.", epicQid,
    ]);
    expect(createStory.status).toBe(0);

    // Get story qid
    const tree2Result = runCmd([
      "uv", "run", "loom",
      "tree", "--root", loomDir, "--json", epicQid,
    ]);
    expect(tree2Result.status).toBe(0);
    const { items: tree2 }: { items: Array<{ qid: string; type: string }> } = JSON.parse(tree2Result.stdout.trim());
    const storyItem = tree2.find((item) => item.type === "story");
    expect(storyItem).toBeDefined();
    const storyQid = storyItem!.qid;

    // Create two tasks
    const createTask1 = runCmd([
      "uv", "run", "loom", "-y",
      "task", "create", "--root", loomDir,
      "--title", "Python Task 1", "--body", "Task body one.", storyQid,
    ]);
    expect(createTask1.status).toBe(0);

    const createTask2 = runCmd([
      "uv", "run", "loom", "-y",
      "task", "create", "--root", loomDir,
      "--title", "Python Task 2", "--body", "Task body two.", storyQid,
    ]);
    expect(createTask2.status).toBe(0);

    // Get task qids
    const tree3Result = runCmd([
      "uv", "run", "loom",
      "tree", "--root", loomDir, "--json", storyQid,
    ]);
    expect(tree3Result.status).toBe(0);
    const { items: tree3 }: { items: Array<{ qid: string; type: string; title: string }> } = JSON.parse(tree3Result.stdout.trim());
    const task1Item = tree3.find((item) => item.type === "task" && item.title === "Python Task 1");
    const task2Item = tree3.find((item) => item.type === "task" && item.title === "Python Task 2");
    expect(task1Item).toBeDefined();
    expect(task2Item).toBeDefined();
    const task1Qid = task1Item!.qid;
    const task2Qid = task2Item!.qid;

    // Add dep: task2 depends on task1
    const addDep = runCmd([
      "uv", "run", "loom", "-y",
      "dep", "add", "--root", loomDir, task2Qid, "--on", task1Qid,
    ]);
    expect(addDep.status).toBe(0);

    // Now read via TS lib — must see the same fields
    const loom = new Loom(loomDir);
    // Rebuild so the TS index is fresh from the Python-authored filesystem
    await loom.rebuild();

    const project = loom.get("py") as import("./items").Project;
    expect(project).toBeDefined();
    expect(project.title).toBe("Python Project");
    expect(project.repo).toBe("https://github.com/example/py");

    const story = loom.get(storyQid) as import("./items").Story;
    expect(story).toBeDefined();
    expect(story.title).toBe("Python Story");
    expect(story.body).toContain("Story from Python.");

    const task1 = loom.get(task1Qid) as import("./items").Task;
    const task2 = loom.get(task2Qid) as import("./items").Task;
    expect(task1).toBeDefined();
    expect(task2).toBeDefined();
    expect(task1.title).toBe("Python Task 1");
    expect(task2.title).toBe("Python Task 2");
    expect(task1.body).toContain("Task body one.");
    expect(task2.body).toContain("Task body two.");

    // Dependency: task2 must list task1 as its dependency
    const deps = computeDependencies(loom.index, task2Qid);
    const depQids = deps.map((d) => d.qualifiedId);
    expect(depQids).toContain(task1Qid);
  });
});
