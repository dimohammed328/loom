#!/usr/bin/env bash
#
# Deploy the loom CLI as an isolated, pinned `uv tool` install.
#
# The deployed `loom` (on your PATH at ~/.local/bin/loom) is a frozen
# snapshot built from a git tag, fully decoupled from this repo's editable
# working tree. Develop with `uv run loom`; users run the snapshot. This
# script (re)installs that snapshot from a tagged commit.
#
# Usage:
#   scripts/deploy.sh            # deploy the version in pyproject.toml
#   scripts/deploy.sh v0.2.0     # deploy an explicit tag
#
# A redeploy of an existing tag is idempotent. To ship new code: bump the
# `version` in pyproject.toml, commit, then run this script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Resolve the target tag: explicit arg, else vX from pyproject.toml.
if [[ $# -ge 1 ]]; then
  TAG="$1"
else
  VERSION="$(grep -m1 '^version' pyproject.toml | sed -E 's/.*"(.*)".*/\1/')"
  TAG="v${VERSION}"
fi

# The tag captures committed state only — refuse to deploy a dirty tree so
# the deployed snapshot always matches a real commit.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty; commit or stash before deploying" >&2
  exit 1
fi

# Create the tag at HEAD if absent (idempotent redeploy of an existing tag).
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "tag ${TAG} already exists; redeploying from it"
else
  echo "tagging $(git rev-parse --short HEAD) as ${TAG}"
  git tag -a "${TAG}" -m "loom ${TAG}"
  # Push the tag if an 'origin' remote exists (best-effort; non-fatal).
  if git remote get-url origin >/dev/null 2>&1; then
    git push origin "${TAG}" || echo "warning: could not push ${TAG} to origin" >&2
  fi
fi

# Install the frozen snapshot from the tag, overwriting any existing shim.
uv tool install --force --from "git+file://${REPO_ROOT}@${TAG}" loom

echo "deployed loom ${TAG} -> $(command -v loom)"
