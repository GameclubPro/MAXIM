#!/usr/bin/env bash

monitor_read_process_identity() {
  local pid="$1"
  local remainder
  local stat
  local -a fields=()

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "/proc/$pid/stat" ]] || return 1
  IFS= read -r stat <"/proc/$pid/stat" || return 1
  remainder="${stat##*) }"
  [[ "$remainder" != "$stat" ]] || return 1
  IFS=' ' read -r -a fields <<<"$remainder"
  [[ "${fields[1]:-}" =~ ^[0-9]+$ ]] || return 1
  [[ "${fields[2]:-}" =~ ^[0-9]+$ ]] || return 1
  [[ "${fields[3]:-}" =~ ^[0-9]+$ ]] || return 1
  [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  [[ "${fields[0]:-}" =~ ^[A-Za-z]$ ]] || return 1
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$pid" "${fields[0]}" "${fields[1]}" "${fields[2]}" "${fields[3]}" "${fields[19]}"
}

monitor_process_identity_matches() {
  local expected_pid="$1"
  local expected_starttime="$2"
  local identity
  local pid _state _ppid _pgrp _session starttime

  identity="$(monitor_read_process_identity "$expected_pid")" || return 1
  IFS=$'\t' read -r pid _state _ppid _pgrp _session starttime <<<"$identity"
  [[ "$pid" == "$expected_pid" && "$starttime" == "$expected_starttime" ]]
}

monitor_process_identity_is_alive() {
  local expected_pid="$1"
  local expected_starttime="$2"
  local identity
  local pid state _ppid _pgrp _session starttime

  identity="$(monitor_read_process_identity "$expected_pid")" || return 1
  IFS=$'\t' read -r pid state _ppid _pgrp _session starttime <<<"$identity"
  [[ "$pid" == "$expected_pid" &&
    "$starttime" == "$expected_starttime" &&
    "$state" != 'Z' &&
    "$state" != 'X' &&
    "$state" != 'x' ]]
}

monitor_session_leader_identity_matches() {
  local expected_session="$1"
  local expected_starttime="$2"
  local identity
  local pid state _ppid pgrp session starttime

  identity="$(monitor_read_process_identity "$expected_session")" || return 1
  IFS=$'\t' read -r pid state _ppid pgrp session starttime <<<"$identity"
  [[ "$pid" == "$expected_session" &&
    "$pgrp" == "$expected_session" &&
    "$session" == "$expected_session" &&
    "$starttime" == "$expected_starttime" &&
    "$state" != 'Z' &&
    "$state" != 'X' &&
    "$state" != 'x' ]]
}

monitor_wait_for_process_starttime() {
  local pid="$1"
  local attempts="${2:-100}"
  local attempt
  local identity
  local _observed_pid state _ppid _pgrp _session starttime

  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if identity="$(monitor_read_process_identity "$pid" 2>/dev/null)"; then
      IFS=$'\t' read -r _observed_pid state _ppid _pgrp _session starttime <<<"$identity"
      if [[ "$state" != 'Z' && "$state" != 'X' && "$state" != 'x' ]]; then
        printf '%s' "$starttime"
        return 0
      fi
    fi
    sleep 0.01
  done
  return 1
}

monitor_wait_for_session_leader() {
  local pid="$1"
  local attempts="${2:-100}"
  local attempt
  local identity
  local observed_pid state _ppid pgrp session starttime

  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if identity="$(monitor_read_process_identity "$pid" 2>/dev/null)"; then
      IFS=$'\t' read -r observed_pid state _ppid pgrp session starttime <<<"$identity"
      if [[ "$observed_pid" == "$pid" && "$pgrp" == "$pid" && "$session" == "$pid" ]]; then
        if [[ "$state" != 'Z' && "$state" != 'X' && "$state" != 'x' ]]; then
          printf '%s' "$starttime"
          return 0
        fi
      fi
    fi
    sleep 0.01
  done
  return 1
}

monitor_owned_session_is_alive() {
  local expected_session="$1"
  local minimum_starttime="$2"
  local found=1
  local path
  local remainder
  local stat
  local pid state pgrp session starttime
  local -a fields=()

  [[ "$expected_session" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$minimum_starttime" =~ ^[0-9]+$ ]] || return 1
  for path in /proc/[1-9][0-9]*/stat; do
    [[ -r "$path" ]] || continue
    pid="${path#/proc/}"
    pid="${pid%/stat}"
    IFS= read -r stat <"$path" 2>/dev/null || continue
    remainder="${stat##*) }"
    [[ "$remainder" != "$stat" ]] || continue
    fields=()
    IFS=' ' read -r -a fields <<<"$remainder"
    state="${fields[0]:-}"
    pgrp="${fields[2]:-}"
    session="${fields[3]:-}"
    starttime="${fields[19]:-}"
    if [[ "$pid" == "$expected_session" ]]; then
      if [[ "$pgrp" == "$expected_session" &&
        "$session" == "$expected_session" &&
        "$starttime" == "$minimum_starttime" ]]; then
        if [[ "$state" != 'Z' && "$state" != 'X' && "$state" != 'x' ]]; then
          found=0
        fi
      else
        return 1
      fi
      continue
    fi
    if [[ "$session" == "$expected_session" &&
      "$starttime" =~ ^[0-9]+$ &&
      "$starttime" -ge "$minimum_starttime" &&
      "$state" != 'Z' &&
      "$state" != 'X' &&
      "$state" != 'x' ]]; then
      found=0
    fi
  done
  return "$found"
}

monitor_owned_session_has_descendants() {
  local expected_session="$1"
  local minimum_starttime="$2"
  local found=1
  local path
  local remainder
  local stat
  local pid state pgrp session starttime
  local -a fields=()

  [[ "$expected_session" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$minimum_starttime" =~ ^[0-9]+$ ]] || return 1
  for path in /proc/[1-9][0-9]*/stat; do
    [[ -r "$path" ]] || continue
    pid="${path#/proc/}"
    pid="${pid%/stat}"
    IFS= read -r stat <"$path" 2>/dev/null || continue
    remainder="${stat##*) }"
    [[ "$remainder" != "$stat" ]] || continue
    fields=()
    IFS=' ' read -r -a fields <<<"$remainder"
    state="${fields[0]:-}"
    pgrp="${fields[2]:-}"
    session="${fields[3]:-}"
    starttime="${fields[19]:-}"
    if [[ "$pid" == "$expected_session" ]]; then
      if [[ "$pgrp" != "$expected_session" ||
        "$session" != "$expected_session" ||
        "$starttime" != "$minimum_starttime" ]]; then
        return 1
      fi
      continue
    fi
    if [[ "$session" == "$expected_session" &&
      "$starttime" =~ ^[0-9]+$ &&
      "$starttime" -ge "$minimum_starttime" &&
      "$state" != 'Z' &&
      "$state" != 'X' &&
      "$state" != 'x' ]]; then
      found=0
    fi
  done
  return "$found"
}

monitor_process_identity_in_session_matches() {
  local expected_pid="$1"
  local expected_starttime="$2"
  local expected_session="$3"
  local identity
  local pid state _ppid _pgrp session starttime

  identity="$(monitor_read_process_identity "$expected_pid")" || return 1
  IFS=$'\t' read -r pid state _ppid _pgrp session starttime <<<"$identity"
  [[ "$pid" == "$expected_pid" &&
    "$session" == "$expected_session" &&
    "$starttime" == "$expected_starttime" &&
    "$state" != 'Z' &&
    "$state" != 'X' &&
    "$state" != 'x' ]]
}

monitor_wait_for_owned_tree_exit() {
  local pid="$1"
  local starttime="$2"
  local session="$3"
  local session_starttime="$4"
  local attempts="${5:-20}"
  local attempt

  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if ! monitor_process_identity_is_alive "$pid" "$starttime" &&
      ! monitor_owned_session_is_alive "$session" "$session_starttime"; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

monitor_signal_owned_tree() {
  local signal="$1"
  local pid="$2"
  local starttime="$3"
  local session="$4"
  local session_starttime="$5"
  local path
  local remainder
  local stat
  local candidate_pid candidate_session candidate_starttime
  local -a fields=()

  if monitor_session_leader_identity_matches "$session" "$session_starttime" ||
    monitor_owned_session_is_alive "$session" "$session_starttime"; then
    for path in /proc/[1-9][0-9]*/stat; do
      [[ -r "$path" ]] || continue
      candidate_pid="${path#/proc/}"
      candidate_pid="${candidate_pid%/stat}"
      [[ "$candidate_pid" != "$session" ]] || continue
      IFS= read -r stat <"$path" 2>/dev/null || continue
      remainder="${stat##*) }"
      [[ "$remainder" != "$stat" ]] || continue
      fields=()
      IFS=' ' read -r -a fields <<<"$remainder"
      candidate_session="${fields[3]:-}"
      candidate_starttime="${fields[19]:-}"
      if [[ "$candidate_session" == "$session" &&
        "$candidate_starttime" =~ ^[0-9]+$ &&
        "$candidate_starttime" -ge "$session_starttime" ]] &&
        monitor_process_identity_in_session_matches \
          "$candidate_pid" "$candidate_starttime" "$session"; then
        kill -"$signal" "$candidate_pid" 2>/dev/null || true
      fi
    done
    if monitor_session_leader_identity_matches "$session" "$session_starttime"; then
      kill -"$signal" "$session" 2>/dev/null || true
    fi
    return 0
  fi
  if monitor_process_identity_is_alive "$pid" "$starttime"; then
    kill -"$signal" "$pid" 2>/dev/null || true
  fi
}

monitor_terminate_owned_tree() {
  local pid="$1"
  local starttime="$2"
  local session="$3"
  local session_starttime="$4"

  monitor_signal_owned_tree TERM "$pid" "$starttime" "$session" "$session_starttime"
  if monitor_wait_for_owned_tree_exit "$pid" "$starttime" "$session" "$session_starttime" 20; then
    return 0
  fi

  # FLAG: A surviving descendant must never outlive the monitor lock that contains its work.
  while true; do
    monitor_signal_owned_tree KILL "$pid" "$starttime" "$session" "$session_starttime"
    if monitor_wait_for_owned_tree_exit \
      "$pid" "$starttime" "$session" "$session_starttime" 20; then
      return 0
    fi
  done
}
