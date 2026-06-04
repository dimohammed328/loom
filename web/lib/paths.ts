/** $LOOM_DIR resolution — mirrors src/loom/paths.py.
 *
 * Precedence (first match wins):
 *   1. $LOOM_DIR
 *   2. $XDG_DATA_HOME/loom
 *   3. ~/.local/share/loom
 */

import * as os from "os";
import * as path from "path";

export const ENV_LOOM_DIR = "LOOM_DIR";
export const ENV_XDG_DATA_HOME = "XDG_DATA_HOME";

/** Expand a leading `~/` to the user's home directory. */
function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Return the configured loom data directory as an absolute path string.
 *
 * The directory is not created or validated — this is a pure path computation.
 * Pass an explicit `env` record in tests to avoid depending on the real environment.
 */
export function loomRoot(env?: Record<string, string | undefined>): string {
  const e = env ?? process.env;

  const loomDir = e[ENV_LOOM_DIR];
  if (loomDir) return expandUser(loomDir);

  const xdg = e[ENV_XDG_DATA_HOME];
  if (xdg) return path.join(expandUser(xdg), "loom");

  return path.join(os.homedir(), ".local", "share", "loom");
}
