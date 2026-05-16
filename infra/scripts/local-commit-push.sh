#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"commit message\" [branch] [--include-agents]"
  exit 1
fi

COMMIT_MESSAGE="$1"
BRANCH="$(git branch --show-current)"
INCLUDE_AGENTS=0

if [[ $# -ge 2 ]] && [[ "$2" != --* ]]; then
  BRANCH="$2"
  shift 2
else
  shift 1
fi

for arg in "$@"; do
  case "$arg" in
    --include-agents)
      INCLUDE_AGENTS=1
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 \"commit message\" [branch] [--include-agents]"
      exit 1
      ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  echo "Cannot detect branch. Pass it as second argument."
  exit 1
fi

if [[ "$INCLUDE_AGENTS" -eq 1 ]]; then
  PENDING_STATUS="$(git status --porcelain)"
else
  PENDING_STATUS="$(git status --porcelain -- . ':(exclude)AGENTS.md')"
fi

if [[ -z "$PENDING_STATUS" ]]; then
  if [[ -n "$(git status --porcelain -- AGENTS.md)" ]]; then
    echo "No non-AGENTS changes to commit."
    echo "AGENTS.md is excluded by default. Re-run with --include-agents to commit it intentionally."
    exit 1
  fi

  echo "No changes to commit."
  exit 1
fi

ensure_migration_for_schema_change() {
  local staged
  staged="$(git diff --cached --name-only)"

  if printf '%s\n' "$staged" | grep -qx 'apps/api/prisma/schema.prisma'; then
    if node <<'NODE'
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const schemaPath = 'apps/api/prisma/schema.prisma';
const current = readFileSync(schemaPath, 'utf8');
let previous = '';

try {
  previous = execFileSync('git', ['show', `HEAD:${schemaPath}`], { encoding: 'utf8' });
} catch {
  process.exit(1);
}

function stripRuntimeOnlyBlocks(source) {
  return source
    .replace(/generator\s+client\s*\{[\s\S]*?\n\}/g, '')
    .replace(/datasource\s+db\s*\{[\s\S]*?\n\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

process.exit(stripRuntimeOnlyBlocks(previous) === stripRuntimeOnlyBlocks(current) ? 0 : 1);
NODE
    then
      return
    fi

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
if [[ "$INCLUDE_AGENTS" -eq 1 ]]; then
  git add -A
else
  git add -A -- . ':(exclude)AGENTS.md'
fi
ensure_migration_for_schema_change
git commit -m "$COMMIT_MESSAGE"
git push origin "$BRANCH"

echo "Done: pushed to origin/$BRANCH"
