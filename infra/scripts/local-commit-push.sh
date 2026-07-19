#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"commit message\" [branch] [--all] [--include-agents]"
  exit 1
fi

COMMIT_MESSAGE="$1"
BRANCH="$(git branch --show-current)"
INCLUDE_AGENTS=0
STAGE_ALL=0

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
    --all)
      STAGE_ALL=1
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 \"commit message\" [branch] [--all] [--include-agents]"
      exit 1
      ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  echo "Cannot detect branch. Pass it as second argument."
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  echo "Current branch is $CURRENT_BRANCH, but target branch is $BRANCH."
  echo "Switch to the target branch or pass the current branch explicitly."
  exit 1
fi

if [[ "$STAGE_ALL" -eq 1 ]]; then
  if [[ "$INCLUDE_AGENTS" -eq 1 ]]; then
    git add -A
  else
    git add -A -- . ':(exclude)AGENTS.md' ':(glob,exclude)**/AGENTS.md'
  fi
fi

STAGED_FILES="$(git diff --cached --name-only)"
if [[ -z "$STAGED_FILES" ]]; then
  echo "No staged changes to commit. Stage explicit paths or re-run with --all."
  exit 1
fi

if [[ "$INCLUDE_AGENTS" -eq 0 ]] && printf '%s\n' "$STAGED_FILES" | grep -Eq '(^|/)AGENTS\.md$'; then
  echo "A scoped AGENTS.md is staged. Re-run with --include-agents to commit it intentionally."
  exit 1
fi

git status --short
npm run agent:verify -- --staged
git commit -m "$COMMIT_MESSAGE"
git push origin "HEAD:refs/heads/$BRANCH"

echo "Done: pushed to origin/$BRANCH"
