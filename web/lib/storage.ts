/** Atomic markdown I/O with order-preserving YAML frontmatter.
 *
 * The on-disk format is:
 *   ---
 *   <yaml frontmatter>
 *   ---
 *   <markdown body>
 *
 * Files always end with exactly one trailing newline. Writes go via a temp
 * file followed by rename, so a crash mid-write cannot leave a partial file.
 *
 * Mirrors src/loom/storage.py.
 */

import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";
import { ValidationError } from "./errors";

export const FENCE = "---";

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

/**
 * Parse a markdown string into [frontmatter, body].
 *
 * Files without an opening `---` fence have empty frontmatter and the entire
 * content as body. A file that opens a fence but never closes one raises
 * ValidationError.
 */
export function parse(
  text: string,
  source?: string
): [Record<string, unknown>, string] {
  const rawLines = splitKeepingEnds(text);

  if (rawLines.length === 0 || rawLines[0]!.trimEnd() !== FENCE) {
    return [{}, text];
  }

  let closeIdx: number | null = null;
  for (let i = 1; i < rawLines.length; i++) {
    if (rawLines[i]!.trimEnd() === FENCE) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === null) {
    const suffix = source ? ` (source: ${source})` : "";
    throw new ValidationError(
      null,
      `frontmatter opening '---' has no closing fence${suffix}`
    );
  }

  const yamlText = rawLines.slice(1, closeIdx).join("");
  const body = rawLines.slice(closeIdx + 1).join("");

  let loaded: unknown;
  try {
    loaded = yamlText.trim() ? yaml.load(yamlText) : null;
  } catch (e) {
    const suffix = source ? ` (source: ${source})` : "";
    throw new ValidationError(
      null,
      `frontmatter is not valid YAML${suffix}: ${String(e)}`
    );
  }

  if (loaded === null || loaded === undefined) {
    loaded = {};
  }
  if (typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new ValidationError(
      null,
      `frontmatter must be a YAML mapping, got ${typeof loaded}`
    );
  }

  return [loaded as Record<string, unknown>, body];
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/**
 * Serialize frontmatter + body to the canonical on-disk form.
 * Key insertion order is preserved. Output ends with exactly one newline.
 */
export function render(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const parts: string[] = [];

  if (Object.keys(frontmatter).length > 0) {
    let yamlText = yaml.dump(frontmatter, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
      noRefs: true,
    });
    if (!yamlText.endsWith("\n")) yamlText += "\n";
    parts.push(FENCE + "\n");
    parts.push(yamlText);
    parts.push(FENCE + "\n");
  }

  if (body) {
    parts.push(body.replace(/\n+$/, "") + "\n");
  }

  let out = parts.join("");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

// ---------------------------------------------------------------------------
// atomic I/O
// ---------------------------------------------------------------------------

/**
 * Read a markdown file, returning [frontmatter, body].
 */
export function load(filePath: string): [Record<string, unknown>, string] {
  const text = fs.readFileSync(filePath, "utf-8");
  return parse(text, filePath);
}

/**
 * Atomically write frontmatter + body to filePath (tempfile + rename).
 */
export function dump(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string
): void {
  atomicWriteText(filePath, render(frontmatter, body));
}

/**
 * Atomically write content to filePath via a temp file + rename.
 */
export function atomicWriteText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// body hashing
// ---------------------------------------------------------------------------

/**
 * Return the sha256 hex digest of the raw on-disk bytes of filePath.
 * Mirrors the Python body_hash contract: hash of raw bytes, never re-rendered.
 */
export async function bodyHash(filePath: string): Promise<string> {
  const bytes = fs.readFileSync(filePath);
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split text into lines keeping line endings attached. */
function splitKeepingEnds(text: string): string[] {
  if (text === "") return [];
  const result: string[] = [];
  let i = 0;
  while (i < text.length) {
    const nlIdx = text.indexOf("\n", i);
    if (nlIdx === -1) {
      result.push(text.slice(i));
      break;
    }
    result.push(text.slice(i, nlIdx + 1));
    i = nlIdx + 1;
  }
  return result;
}
