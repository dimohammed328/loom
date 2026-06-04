/** Loom exception hierarchy — mirrors src/loom/errors.py */

export class LoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoomError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidQualifiedId extends LoomError {
  readonly raw: string;
  readonly reason: string;

  constructor(raw: string, reason: string) {
    super(`invalid qualified id ${JSON.stringify(raw)}: ${reason}`);
    this.name = "InvalidQualifiedId";
    this.raw = raw;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ReservedName extends LoomError {
  /** The reserved project name. Named name_ to avoid shadowing Error.name. */
  readonly name_: string;

  constructor(name: string) {
    super(
      `project name ${JSON.stringify(name)} is reserved (cannot start with '_' or be one of ` +
        `'projects', 'loom', '_archive')`
    );
    this.name = "ReservedName";
    this.name_ = name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFound extends LoomError {
  readonly qualifiedId: string;

  constructor(qualifiedId: string) {
    super(`item not found: ${qualifiedId}`);
    this.name = "NotFound";
    this.qualifiedId = qualifiedId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class Duplicate extends LoomError {
  readonly qualifiedId: string;

  constructor(qualifiedId: string) {
    super(`item already exists: ${qualifiedId}`);
    this.name = "Duplicate";
    this.qualifiedId = qualifiedId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CycleError extends LoomError {
  readonly sourceId: string;
  readonly targetId: string;
  readonly cycle: string[];

  constructor(sourceId: string, targetId: string, cycle: string[]) {
    const path = cycle.join(" -> ");
    super(`dependency ${sourceId} -> ${targetId} would create a cycle: ${path}`);
    this.name = "CycleError";
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.cycle = cycle;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class Drift extends LoomError {
  readonly qualifiedId: string;
  readonly filePath: string;

  constructor(qualifiedId: string, filePath: string) {
    super(
      `drift detected for ${qualifiedId} at ${filePath}: ` +
        `on-disk content differs from indexed hash`
    );
    this.name = "Drift";
    this.qualifiedId = qualifiedId;
    this.filePath = filePath;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends LoomError {
  readonly qualifiedId: string | null;
  readonly reason: string;

  constructor(qualifiedId: string | null, reason: string) {
    const prefix = qualifiedId != null ? `${qualifiedId}: ` : "";
    super(`${prefix}${reason}`);
    this.name = "ValidationError";
    this.qualifiedId = qualifiedId;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
