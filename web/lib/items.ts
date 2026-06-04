/**
 * Item classes: Item base + mutator contract, _Statused mixin,
 * concrete Project/Epic/Story/Task, and helpers.
 *
 * Mirrors src/loom/items.py.
 *
 * The five-step mutator contract (see CLAUDE.md):
 *  1. Read file from disk (preserving unknown frontmatter keys).
 *  2. Apply the change in-memory.
 *  3. Atomically rewrite the file via storage.dump.
 *  4. Re-derive the IndexRecord and apply it to the index.
 *  5. Update self._record so the same instance reflects the change.
 *
 * Step 5: other in-memory copies of the same item are detached snapshots
 * and must call refresh() to see the change.
 */

import * as fs from "fs";
import * as path from "path";
import { Index, IndexRecord } from "./index";
import { load, dump } from "./storage";
import { buildRecordSync } from "./scan";
import {
  QualifiedId,
  ItemType,
  path_from_qid,
  parse_qid,
  TASKS_DIRNAME,
  STORIES_DIRNAME,
} from "./ids";
import { LoomError, NotFound, Duplicate } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function qidPathExistsAnywhere(root: string, qid: QualifiedId): boolean {
  return (
    fs.existsSync(path_from_qid(qid, root, false)) ||
    fs.existsSync(path_from_qid(qid, root, true))
  );
}

/**
 * Compute the next sequential id under parent for child_type.
 * Scans both live and archived parent directories so archived siblings
 * are never reused.
 */
export function nextSequentialId(
  root: string,
  parent: QualifiedId,
  childType: ItemType.STORY | ItemType.TASK
): number {
  const subdir = childType === ItemType.STORY ? STORIES_DIRNAME : TASKS_DIRNAME;
  const isMatch =
    childType === ItemType.STORY
      ? isIntDir
      : isIntMdFile;

  let maxId = 0;
  for (const archived of [false, true]) {
    const parentPath = path.dirname(path_from_qid(parent, root, archived));
    const subdirPath = path.join(parentPath, subdir);
    if (!fs.existsSync(subdirPath)) continue;
    for (const entry of fs.readdirSync(subdirPath, { withFileTypes: true })) {
      const entryPath = path.join(subdirPath, entry.name);
      const n = isMatch(entryPath, entry.name, entry);
      if (n !== null && n > maxId) maxId = n;
    }
  }
  return maxId + 1;
}

function isIntDir(
  _fullPath: string,
  name: string,
  entry: fs.Dirent
): number | null {
  if (!entry.isDirectory()) return null;
  if (!/^\d+$/.test(name)) return null;
  const n = parseInt(name, 10);
  return String(n) === name && n >= 1 ? n : null;
}

function isIntMdFile(
  _fullPath: string,
  name: string,
  entry: fs.Dirent
): number | null {
  if (!entry.isFile() || !name.endsWith(".md")) return null;
  const stem = name.slice(0, -3);
  if (!/^\d+$/.test(stem)) return null;
  const n = parseInt(stem, 10);
  return String(n) === stem && n >= 1 ? n : null;
}

export function buildFrontmatter(
  qid: QualifiedId,
  title: string,
  status: string | null,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  const now = nowIso();
  const fm: Record<string, unknown> = {
    schema_version: 3,
    id: qid.localId,
    qualified_id: qid.toString(),
    type: qid.type.valueOf(),
    title,
    created_at: now,
    updated_at: now,
  };
  if (status !== null) fm["status"] = status;
  for (const [k, v] of Object.entries(extras)) {
    if (v !== null && v !== undefined) fm[k] = v;
  }
  return fm;
}

/**
 * Atomically create a new item file and apply it to the index.
 * Raises Duplicate if a file already exists at the path.
 */
export async function createItemFile(
  root: string,
  qid: QualifiedId,
  fm: Record<string, unknown>,
  body: string
): Promise<IndexRecord> {
  if (qidPathExistsAnywhere(root, qid)) {
    throw new Duplicate(qid.toString());
  }
  const filePath = path_from_qid(qid, root);
  dump(filePath, fm, body);
  try {
    const record = await buildRecord(filePath, root);
    new Index(root).applyRecord(record);
    return record;
  } catch (e) {
    fs.rmSync(filePath, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Item base
// ---------------------------------------------------------------------------

export class Item {
  protected _root: string;
  protected _record: IndexRecord;
  protected _body: string | null = null;

  constructor(root: string, record: IndexRecord) {
    this._root = root;
    this._record = record;
  }

  // ----- identity ----------------------------------------------------------

  get root(): string {
    return this._root;
  }

  get record(): IndexRecord {
    return this._record;
  }

  get qualifiedId(): string {
    return this._record.qualified_id;
  }

  get qid(): QualifiedId {
    return parse_qid(this._record.qualified_id);
  }

  get type(): string {
    return this._record.type;
  }

  get parentId(): string | null {
    return this._record.parent_id;
  }

  get filePath(): string {
    return path.join(this._root, this._record.file_path);
  }

  // ----- metadata snapshot -------------------------------------------------

  get title(): string {
    return this._record.title;
  }

  get assignee(): string | null {
    return this._record.assignee;
  }

  get branch(): string | null {
    return this._record.branch;
  }

  get prUrl(): string | null {
    return this._record.pr_url;
  }

  get archived(): boolean {
    return this._record.archived;
  }

  get createdAt(): string {
    return this._record.created_at;
  }

  get updatedAt(): string {
    return this._record.updated_at;
  }

  get tags(): readonly string[] {
    return this._record.tags;
  }

  get body(): string {
    if (this._body === null) {
      const [, body] = load(this.filePath);
      this._body = body;
    }
    return this._body;
  }

  // ----- repr --------------------------------------------------------------

  toString(): string {
    return `<${this.constructor.name} ${JSON.stringify(this.qualifiedId)}>`;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Item &&
      this.qualifiedId === other.qualifiedId &&
      this._root === other._root
    );
  }

  // ----- mutation primitives -----------------------------------------------

  /**
   * Merge changes into the frontmatter, bump updated_at, re-index.
   * undefined values are skipped; null values delete the key.
   */
  protected _mutateFrontmatter(changes: Record<string, unknown>): void {
    const filePath = this.filePath;
    const [fm, body] = load(filePath);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      if (value === null) {
        delete fm[key];
      } else {
        fm[key] = value;
      }
    }
    fm["updated_at"] = nowIso();
    dump(filePath, fm, body);
    this._body = null;
    // Sync index synchronously via a fresh buildRecord (async — but items.ts
    // matches Python's sync pattern; we call this from async callers).
    // Use a synchronous workaround: re-read and applyRecord inline.
    this._syncRecordSync(filePath);
  }

  protected _syncRecordSync(filePath: string): void {
    const record = buildRecordSync(filePath, this._root);
    new Index(this._root).applyRecord(record);
    this._record = record;
  }

  protected _replaceTags(newTags: string[]): void {
    const filePath = this.filePath;
    const [fm, body] = load(filePath);
    const unique = [...new Set(newTags.map(String))];
    if (unique.length > 0) {
      fm["tags"] = unique;
    } else {
      delete fm["tags"];
    }
    fm["updated_at"] = nowIso();
    dump(filePath, fm, body);
    this._body = null;
    this._syncRecordSync(filePath);
  }

  // ----- universal setters -------------------------------------------------

  setTitle(title: string): this {
    this._mutateFrontmatter({ title: String(title) });
    return this;
  }

  setBody(body: string): this {
    const filePath = this.filePath;
    const [fm] = load(filePath);
    fm["updated_at"] = nowIso();
    dump(filePath, fm, body);
    this._body = null;
    this._syncRecordSync(filePath);
    return this;
  }

  addTag(tag: string): this {
    if (this._record.tags.includes(tag)) return this;
    this._replaceTags([...this._record.tags, String(tag)]);
    return this;
  }

  removeTag(tag: string): this {
    if (!this._record.tags.includes(tag)) return this;
    this._replaceTags(this._record.tags.filter((t) => t !== tag));
    return this;
  }

  // ----- refresh / archive -------------------------------------------------

  refresh(): this {
    const rec = new Index(this._root).get(this.qualifiedId);
    if (rec === null) throw new NotFound(this.qualifiedId);
    this._record = rec;
    this._body = null;
    return this;
  }

  archive(): this {
    if (this._record.archived) {
      throw new LoomError(`${this.qualifiedId} is already archived`);
    }

    const src = this.filePath;
    const qidObj = this.qid;
    const dst = path_from_qid(qidObj, this._root, true);

    // For containers, move the directory; for tasks, move the file.
    let moveSrc: string;
    let moveDst: string;
    if (this.type === ItemType.TASK.valueOf()) {
      moveSrc = src;
      moveDst = dst;
    } else {
      moveSrc = path.dirname(src);
      moveDst = path.dirname(dst);
    }

    if (fs.existsSync(moveDst)) {
      throw new LoomError(
        `cannot archive ${this.qualifiedId}: destination already exists at ` +
          path.relative(this._root, moveDst)
      );
    }

    fs.mkdirSync(path.dirname(moveDst), { recursive: true });
    fs.renameSync(moveSrc, moveDst);

    // Re-sync every affected md file.
    if (this.type === ItemType.TASK.valueOf()) {
      this._syncArchivedFile(dst);
    } else {
      this._walkAndSync(moveDst);
    }

    this.refresh();
    return this;
  }

  private _syncArchivedFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    this._syncRecordSync(filePath);
  }

  private _walkAndSync(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this._walkAndSync(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const rec = buildRecordSync(fullPath, this._root);
          new Index(this._root).applyRecord(rec);
        } catch {
          // ignore stray files
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// _Statused mixin
// ---------------------------------------------------------------------------

export class _Statused extends Item {
  get status(): string {
    return this._record.status as string;
  }

  setStatus(status: string): this {
    if (typeof status !== "string" || !status) {
      throw new Error("status must be a non-empty string");
    }
    this._mutateFrontmatter({ status });
    return this;
  }

  complete(): this {
    return this.setStatus("done");
  }

  block(): this {
    return this.setStatus("blocked");
  }

  markReady(): this {
    return this.setStatus("ready");
  }

  setAssignee(assignee: string | null): this {
    this._mutateFrontmatter({ assignee });
    return this;
  }

  setBranch(branch: string | null): this {
    this._mutateFrontmatter({ branch });
    return this;
  }

  setPrUrl(prUrl: string | null): this {
    this._mutateFrontmatter({ pr_url: prUrl });
    return this;
  }

  // ----- dependencies (Phase 4) ------------------------------------------

  async dependsOn(targetQid: string): Promise<this> {
    const { addDependency } = await import("./deps");
    await addDependency(this._root, this.qualifiedId, targetQid);
    this.refresh();
    return this;
  }

  async removeDependency(targetQid: string): Promise<this> {
    const { removeDependency } = await import("./deps");
    await removeDependency(this._root, this.qualifiedId, targetQid);
    this.refresh();
    return this;
  }

  dependencies(): import("./deps").ItemRef[] {
    const { computeDependencies } = require("./deps");
    return computeDependencies(new Index(this._root), this.qualifiedId);
  }

  dependents(): import("./deps").ItemRef[] {
    const { computeDependents } = require("./deps");
    return computeDependents(new Index(this._root), this.qualifiedId);
  }

  blockers(): import("./deps").ItemRef[] {
    const { computeBlockers } = require("./deps");
    return computeBlockers(new Index(this._root), this.qualifiedId);
  }

  isPickable(): boolean {
    const { isPickable } = require("./deps");
    return isPickable(new Index(this._root), this.qualifiedId);
  }
}

// ---------------------------------------------------------------------------
// Concrete item classes (stubs; full implementation in task 5)
// ---------------------------------------------------------------------------

export class Project extends Item {
  get repo(): string | null {
    return this._record.repo;
  }

  get defaultBranch(): string | null {
    return this._record.default_branch;
  }

  setRepo(repo: string | null): this {
    this._mutateFrontmatter({ repo });
    return this;
  }

  setDefaultBranch(branch: string | null): this {
    this._mutateFrontmatter({ default_branch: branch });
    return this;
  }

  // createEpic and epics() implemented in items-ext.ts (task 5)
  async createEpic(_opts: { title: string; body?: string; epicId?: string }): Promise<Epic> {
    throw new LoomError("createEpic not yet implemented — use task 5");
  }

  epics(): Epic[] {
    const records = new Index(this._root).find({ type: "epic", project: this._record.project });
    return records.map((r) => new Epic(this._root, r));
  }
}

export class Epic extends _Statused {
  async createStory(_opts: { title: string; body?: string }): Promise<Story> {
    throw new LoomError("createStory not yet implemented — use task 5");
  }

  stories(): Story[] {
    const records = new Index(this._root).find({ type: "story", project: this._record.project });
    return records
      .filter((r) => r.epic === this._record.epic)
      .map((r) => new Story(this._root, r));
  }
}

export class Story extends _Statused {
  async createTask(_opts: { title: string; body?: string }): Promise<Task> {
    throw new LoomError("createTask not yet implemented — use task 5");
  }

  tasks(): Task[] {
    const records = new Index(this._root).find({ type: "task", project: this._record.project });
    return records
      .filter((r) => r.epic === this._record.epic && r.story === this._record.story)
      .map((r) => new Task(this._root, r));
  }
}

export class Task extends _Statused {
  // Leaf item — no children.
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const TYPE_TO_CLASS: Record<string, new (root: string, record: IndexRecord) => Item> = {
  project: Project,
  epic: Epic,
  story: Story,
  task: Task,
};

export function itemFromRecord(root: string, record: IndexRecord): Item {
  const cls = TYPE_TO_CLASS[record.type];
  if (!cls) throw new LoomError(`unknown item type: ${record.type}`);
  return new cls(root, record);
}

export function itemsFromRecords(root: string, records: IndexRecord[]): Item[] {
  return records.map((r) => itemFromRecord(root, r));
}
