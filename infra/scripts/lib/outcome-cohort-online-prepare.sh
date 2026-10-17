#!/usr/bin/env bash

# FLAG: Fixed observation indexes prepare before any worker pause. This hook never
# borrows the historical multibot authority cutoff or retries an uncertain build.
maxim_outcome_cohort_preflight() {
  local compose_args_var="$1"
  local -n outcome_compose_args_ref="$compose_args_var"
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  node "$ROOT_DIR/infra/scripts/outcome-cohort-online-supervisor.mjs" preflight "${outcome_compose_args_ref[@]}"
}

maxim_outcome_cohort_prepare() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  ensure_compose_env
  MAXIM_MIGRATION_API_IMAGE="$MAXIM_API_IMAGE" \
    node "$ROOT_DIR/infra/scripts/outcome-cohort-online-supervisor.mjs" prepare "${MIGRATION_COMPOSE_FILES[@]}" || return
  maxim_outcome_cohort_assert MIGRATION_COMPOSE_FILES
}

maxim_outcome_cohort_assert() {
  local compose_args_var="$1"
  local -n outcome_compose_args_ref="$compose_args_var"
  node "$ROOT_DIR/infra/scripts/outcome-cohort-online-state.mjs" assert "${outcome_compose_args_ref[@]}"
}
