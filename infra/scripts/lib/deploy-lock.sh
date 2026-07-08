#!/usr/bin/env bash

DEPLOY_LOCK_DIR="${MAXIM_DEPLOY_LOCK_DIR:-/tmp/maxim-main-deploy.lock}"

acquire_deploy_lock() {
  local existing_pid

  if mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$DEPLOY_LOCK_DIR/pid"
    trap release_deploy_lock EXIT
    return 0
  fi

  existing_pid="$(cat "$DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$existing_pid" == "$$" ]]; then
    trap release_deploy_lock EXIT
    return 0
  fi

  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Another runtime deploy or rollback is already running (pid=$existing_pid)." >&2
    return 1
  fi

  echo "Removing stale runtime deploy lock: $DEPLOY_LOCK_DIR" >&2
  rm -rf "$DEPLOY_LOCK_DIR"
  if mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$DEPLOY_LOCK_DIR/pid"
    trap release_deploy_lock EXIT
    return 0
  fi

  echo "Failed to acquire runtime deploy lock: $DEPLOY_LOCK_DIR" >&2
  return 1
}

release_deploy_lock() {
  local existing_pid

  existing_pid="$(cat "$DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$existing_pid" == "$$" ]]; then
    rm -rf "$DEPLOY_LOCK_DIR"
  fi
}
