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

ensure_migration_for_schema_change() {
  local staged
  staged="$(git diff --cached --name-only)"

  if printf '%s\n' "$staged" | grep -qx 'apps/api/prisma/schema.prisma'; then
    if ! printf '%s\n' "$staged" | grep -Eq '^apps/api/prisma/migrations/[^/]+/migration\.sql$'; then
      echo "schema.prisma changed, but no migration.sql is staged."
      echo "Create migration before push, then rerun this script."
      echo "Example:"
      echo "  npm run prisma:migrate:dev --workspace @maxim/api -- --name <migration_name>"
      exit 1
    fi
  fi
}

git status -s
git add -A
ensure_migration_for_schema_change
git commit -m "$COMMIT_MESSAGE"
git push origin "$BRANCH"

echo "Done: pushed to origin/$BRANCH"
