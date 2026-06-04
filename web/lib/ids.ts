/** Qualified identifiers and path<->ID bijection — mirrors src/loom/ids.py */

import { InvalidQualifiedId, ReservedName } from "./errors";

export const PROJECT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export const EPIC_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
export const EPIC_ID_LEN = 7;
const EPIC_ID_RE = new RegExp(`^[${EPIC_ALPHABET}]{${EPIC_ID_LEN}}$`);
export const BACKLOG_EPIC_ID = "backlog";

function isValidEpicId(s: string): boolean {
  return s === BACKLOG_EPIC_ID || EPIC_ID_RE.test(s);
}

export const RESERVED_NAMES = new Set(["projects", "loom", "_archive"]);

export const ARCHIVE_DIRNAME = "_archive";
export const PROJECTS_DIRNAME = "projects";
export const EPICS_DIRNAME = "epics";
export const STORIES_DIRNAME = "stories";
export const TASKS_DIRNAME = "tasks";

export const PROJECT_FILENAME = "project.md";
export const EPIC_FILENAME = "epic.md";
export const STORY_FILENAME = "story.md";

export enum ItemType {
  PROJECT = "project",
  EPIC = "epic",
  STORY = "story",
  TASK = "task",
}

export class QualifiedId {
  readonly project: string;
  readonly epic: string | null;
  readonly story: number | null;
  readonly task: number | null;

  constructor(
    project: string,
    epic: string | null = null,
    story: number | null = null,
    task: number | null = null
  ) {
    this.project = project;
    this.epic = epic;
    this.story = story;
    this.task = task;
  }

  get type(): ItemType {
    if (this.task !== null) return ItemType.TASK;
    if (this.story !== null) return ItemType.STORY;
    if (this.epic !== null) return ItemType.EPIC;
    return ItemType.PROJECT;
  }

  get localId(): string {
    if (this.task !== null) return String(this.task);
    if (this.story !== null) return String(this.story);
    if (this.epic !== null) return this.epic;
    return this.project;
  }

  get parent(): QualifiedId | null {
    switch (this.type) {
      case ItemType.TASK:
        return new QualifiedId(this.project, this.epic, this.story);
      case ItemType.STORY:
        return new QualifiedId(this.project, this.epic);
      case ItemType.EPIC:
        return new QualifiedId(this.project);
      case ItemType.PROJECT:
        return null;
    }
  }

  toString(): string {
    const parts: string[] = [this.project];
    if (this.epic !== null) parts.push(this.epic);
    if (this.story !== null) parts.push(String(this.story));
    if (this.task !== null) parts.push(String(this.task));
    return parts.join(":");
  }
}

export function validate_project_name(name: string): void {
  if (RESERVED_NAMES.has(name) || name.startsWith("_")) {
    throw new ReservedName(name);
  }
  if (!PROJECT_NAME_RE.test(name)) {
    throw new InvalidQualifiedId(
      name,
      "project name must match ^[a-z][a-z0-9_-]{0,63}$"
    );
  }
}

function parseIndex(raw: string, segment: string): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new InvalidQualifiedId(
      raw,
      `${segment} segment must be a positive decimal integer`
    );
  }
  const n = parseInt(raw, 10);
  if (String(n) !== raw) {
    throw new InvalidQualifiedId(raw, `${segment} segment has leading zeros`);
  }
  if (n < 1) {
    throw new InvalidQualifiedId(raw, `${segment} segment must be >= 1`);
  }
  return n;
}

export function parse_qid(s: string): QualifiedId {
  if (typeof s !== "string") {
    throw new InvalidQualifiedId(String(s), "qualified id must be a string");
  }
  if (s !== s.trim() || /\s/.test(s)) {
    throw new InvalidQualifiedId(s, "qualified id must contain no whitespace");
  }

  const parts = s.split(":");
  if (parts.length < 1 || parts.length > 4) {
    throw new InvalidQualifiedId(s, "qualified id must have 1-4 colon-delimited segments");
  }
  if (parts.some((p) => p === "")) {
    throw new InvalidQualifiedId(s, "qualified id must not contain empty segments");
  }

  const project = parts[0]!;
  validate_project_name(project);

  if (parts.length === 1) return new QualifiedId(project);

  const epic = parts[1]!;
  if (!isValidEpicId(epic)) {
    throw new InvalidQualifiedId(
      s,
      `epic segment ${JSON.stringify(epic)} must be ${EPIC_ID_LEN} chars from the epic alphabet ` +
        `or the literal ${JSON.stringify(BACKLOG_EPIC_ID)}`
    );
  }

  if (parts.length === 2) return new QualifiedId(project, epic);

  const story = parseIndex(parts[2]!, "story");
  if (parts.length === 3) return new QualifiedId(project, epic, story);

  const task = parseIndex(parts[3]!, "task");
  return new QualifiedId(project, epic, story, task);
}

export function random_epic_id(): string {
  const len = EPIC_ALPHABET.length;
  let result = "";
  for (let i = 0; i < EPIC_ID_LEN; i++) {
    result += EPIC_ALPHABET[Math.floor(Math.random() * len)];
  }
  return result;
}

// Path bijection functions are defined below (task 4 extension).
export function path_from_qid(
  qid: QualifiedId,
  root: string,
  archived = false
): string {
  const pathJoin = (...parts: string[]) => parts.join("/");
  const base = archived ? pathJoin(root, ARCHIVE_DIRNAME) : root;
  let p = pathJoin(base, PROJECTS_DIRNAME, qid.project);
  if (qid.epic === null) return pathJoin(p, PROJECT_FILENAME);
  p = pathJoin(p, EPICS_DIRNAME, qid.epic);
  if (qid.story === null) return pathJoin(p, EPIC_FILENAME);
  p = pathJoin(p, STORIES_DIRNAME, String(qid.story));
  if (qid.task === null) return pathJoin(p, STORY_FILENAME);
  return pathJoin(p, TASKS_DIRNAME, `${qid.task}.md`);
}

export function qid_from_path(
  filePath: string,
  root: string
): [QualifiedId, boolean] {
  // Normalize by removing trailing slashes for clean prefix matching.
  const normRoot = root.replace(/\/+$/, "");
  if (!filePath.startsWith(normRoot + "/")) {
    throw new InvalidQualifiedId(filePath, `path is not under root ${root}`);
  }
  const rel = filePath.slice(normRoot.length + 1);
  const parts = rel.split("/");

  let archived = false;
  let rest = parts;
  if (rest[0] === ARCHIVE_DIRNAME) {
    archived = true;
    rest = rest.slice(1);
  }

  if (rest.length < 2 || rest[0] !== PROJECTS_DIRNAME) {
    throw new InvalidQualifiedId(filePath, `path must start with '${PROJECTS_DIRNAME}/'`);
  }

  const project = rest[1]!;
  validate_project_name(project);
  rest = rest.slice(2);

  // Project file: project.md
  if (rest.length === 1 && rest[0] === PROJECT_FILENAME) {
    return [new QualifiedId(project), archived];
  }

  if (rest.length < 2 || rest[0] !== EPICS_DIRNAME) {
    throw new InvalidQualifiedId(filePath, `expected '${EPICS_DIRNAME}/<id>' after project`);
  }

  const epic = rest[1]!;
  if (!isValidEpicId(epic)) {
    throw new InvalidQualifiedId(filePath, `invalid epic id segment ${JSON.stringify(epic)}`);
  }
  rest = rest.slice(2);

  // Epic file: epic.md
  if (rest.length === 1 && rest[0] === EPIC_FILENAME) {
    return [new QualifiedId(project, epic), archived];
  }

  if (rest.length < 2 || rest[0] !== STORIES_DIRNAME) {
    throw new InvalidQualifiedId(filePath, `expected '${STORIES_DIRNAME}/<n>' after epic`);
  }

  const story = parseIndex(rest[1]!, "story");
  rest = rest.slice(2);

  // Story file: story.md
  if (rest.length === 1 && rest[0] === STORY_FILENAME) {
    return [new QualifiedId(project, epic, story), archived];
  }

  // Task file: tasks/<T>.md
  if (rest.length === 2 && rest[0] === TASKS_DIRNAME && rest[1]!.endsWith(".md")) {
    const task = parseIndex(rest[1]!.slice(0, -3), "task");
    return [new QualifiedId(project, epic, story, task), archived];
  }

  throw new InvalidQualifiedId(filePath, "path does not match the canonical loom layout");
}
