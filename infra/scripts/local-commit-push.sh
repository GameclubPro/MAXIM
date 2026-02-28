#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"commit message\" [branch]"
  exit 1
fi

COMMIT_MESSAGE="$1"
BRANCH="${2:-$(git branch --show-current)}"

if [[ -z "$BRANCH" ]]; then
  echo "Cannot detect branch. Pass it as second argument."
  exit 1
fi

if [[ -z "$(git status --porcelain)" ]]; then
  echo "No changes to commit."
  exit 1
fi

git status -s
git add -A
git commit -m "$COMMIT_MESSAGE"
git push origin "$BRANCH"

echo "Done: pushed to origin/$BRANCH"
