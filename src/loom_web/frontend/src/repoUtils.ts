/**
 * Utilities for parsing repository URLs into display strings and links.
 *
 * Handles both https and scp-style ssh forms:
 *   https://github.com/owner/repo.git  → "owner/repo"
 *   git@github.com:owner/repo.git      → "owner/repo"
 *   ssh://git@github.com/owner/repo    → "owner/repo"
 */

/**
 * Extract the "owner/repo" display label from a git remote URL.
 *
 * Both https and scp-style ssh forms are supported. If parsing fails,
 * the raw string is returned unchanged.
 */
export function repoLabel(repo: string): string {
  // scp-style ssh: git@github.com:owner/repo.git
  const scpMatch = repo.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (scpMatch) {
    return lastTwoSegments(scpMatch[1]);
  }

  // https or ssh:// URLs
  try {
    const url = new URL(repo);
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return lastTwoSegments(path);
  } catch {
    return repo;
  }
}

/**
 * Derive a normalised https GitHub href from a git remote URL.
 *
 * Returns null when the input cannot be parsed as a GitHub URL.
 */
export function repoHref(repo: string): string | null {
  const label = extractOwnerRepo(repo);
  if (!label) return null;
  return `https://github.com/${label}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return the last two path segments (owner/repo) from a slash-delimited path. */
function lastTwoSegments(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return path;
}

/** Extract raw "owner/repo" string without href derivation. */
function extractOwnerRepo(repo: string): string | null {
  const label = repoLabel(repo);
  // Validate it looks like owner/repo (two slash-separated segments)
  if (/^[^/]+\/[^/]+$/.test(label)) return label;
  return null;
}
