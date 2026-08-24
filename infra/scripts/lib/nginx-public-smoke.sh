#!/usr/bin/env bash

maxim_begin_public_nginx_smoke() {
  if [[ "$#" -ne 5 ]]; then
    return 2
  fi

  local deadline_seconds="$1"
  local max_attempts="$2"
  local attempt_max_seconds="$3"
  local connect_timeout_seconds="$4"
  local retry_delay_seconds="$5"

  if [[ ! "${deadline_seconds}" =~ ^[1-9][0-9]{0,2}$ ]] ||
    [[ ! "${max_attempts}" =~ ^[1-9][0-9]{0,2}$ ]] ||
    [[ ! "${attempt_max_seconds}" =~ ^[1-9][0-9]{0,2}$ ]] ||
    [[ ! "${connect_timeout_seconds}" =~ ^[1-9][0-9]{0,2}$ ]] ||
    [[ ! "${retry_delay_seconds}" =~ ^[0-9]{1,3}$ ]]; then
    return 2
  fi

  MAXIM_PUBLIC_NGINX_SMOKE_DEADLINE_AT=$((SECONDS + deadline_seconds))
  MAXIM_PUBLIC_NGINX_SMOKE_MAX_ATTEMPTS="${max_attempts}"
  MAXIM_PUBLIC_NGINX_SMOKE_ATTEMPT_MAX_SECONDS="${attempt_max_seconds}"
  MAXIM_PUBLIC_NGINX_SMOKE_CONNECT_TIMEOUT_SECONDS="${connect_timeout_seconds}"
  MAXIM_PUBLIC_NGINX_SMOKE_RETRY_DELAY_SECONDS="${retry_delay_seconds}"
}

maxim_public_nginx_final_header_block() {
  awk '
    /^HTTP\/[^[:space:]]+[[:space:]]+[0-9][0-9][0-9]([[:space:]]|$)/ {
      current = $0 ORS
      in_headers = 1
      next
    }
    in_headers && /^[[:space:]]*$/ {
      final = current
      current = ""
      in_headers = 0
      next
    }
    in_headers {
      current = current $0 ORS
    }
    END {
      if (in_headers) {
        final = current
      }
      printf "%s", final
    }
  '
}

maxim_public_nginx_header_values() {
  local header_name="$1"

  awk -v target="${header_name}" '
    index($0, ":") > 0 {
      name = substr($0, 1, index($0, ":") - 1)
      if (tolower(name) == tolower(target)) {
        value = substr($0, index($0, ":") + 1)
        sub(/^[ \t]+/, "", value)
        print value
      }
    }
  '
}

maxim_public_nginx_header_matches() {
  local headers="$1"
  local header_name="$2"
  local expected_value="$3"
  local match_mode="$4"
  local value

  while IFS= read -r value; do
    case "${match_mode}" in
      exact)
        [[ "${value}" == "${expected_value}" ]] && return 0
        ;;
      prefix)
        [[ "${value}" == "${expected_value}"* ]] && return 0
        ;;
      *)
        return 2
        ;;
    esac
  done < <(maxim_public_nginx_header_values "${header_name}" <<<"${headers}")

  return 1
}

maxim_verify_public_nginx_route() {
  if [[ "$#" -ne 6 ]] || [[ -z "${MAXIM_PUBLIC_NGINX_SMOKE_DEADLINE_AT:-}" ]]; then
    return 2
  fi

  local host="$1"
  local path="$2"
  local expected_status="$3"
  local expected_ingress="$4"
  local expected_location="$5"
  local require_security_headers="$6"
  local route="${host}${path}"
  local attempt
  local remaining_seconds
  local attempt_timeout_seconds
  local connect_timeout_seconds
  local response
  local actual_status
  local headers
  local failure_assertion="request"

  for ((attempt = 1; attempt <= MAXIM_PUBLIC_NGINX_SMOKE_MAX_ATTEMPTS; attempt += 1)); do
    remaining_seconds=$((MAXIM_PUBLIC_NGINX_SMOKE_DEADLINE_AT - SECONDS))
    if [[ "${remaining_seconds}" -le 0 ]]; then
      break
    fi

    attempt_timeout_seconds="${MAXIM_PUBLIC_NGINX_SMOKE_ATTEMPT_MAX_SECONDS}"
    if [[ "${remaining_seconds}" -lt "${attempt_timeout_seconds}" ]]; then
      attempt_timeout_seconds="${remaining_seconds}"
    fi
    connect_timeout_seconds="${MAXIM_PUBLIC_NGINX_SMOKE_CONNECT_TIMEOUT_SECONDS}"
    if [[ "${attempt_timeout_seconds}" -lt "${connect_timeout_seconds}" ]]; then
      connect_timeout_seconds="${attempt_timeout_seconds}"
    fi

    failure_assertion="request"
    if response="$(
      curl -sS --connect-timeout "${connect_timeout_seconds}" \
        --max-time "${attempt_timeout_seconds}" -D - -o /dev/null \
        --write-out '\nMAXIM_HTTP_STATUS:%{http_code}' \
        "https://${host}${path}" 2>/dev/null
    )"; then
      response="${response//$'\r'/}"
      actual_status="${response##*$'\nMAXIM_HTTP_STATUS:'}"
      headers="$(
        maxim_public_nginx_final_header_block \
          <<<"${response%$'\nMAXIM_HTTP_STATUS:'*}"
      )"
      failure_assertion=""

      if [[ ! "${actual_status}" =~ ^[0-9]{3}$ ]]; then
        failure_assertion="response-status"
      elif [[ "${actual_status}" != "${expected_status}" ]]; then
        failure_assertion="status:${expected_status}"
      elif [[ -n "${expected_ingress}" ]] &&
        ! maxim_public_nginx_header_matches \
          "${headers}" "x-maxim-ingress" "${expected_ingress}" exact; then
        failure_assertion="header:x-maxim-ingress:${expected_ingress}"
      elif [[ -n "${expected_location}" ]] &&
        ! maxim_public_nginx_header_matches \
          "${headers}" "location" "${expected_location}" exact; then
        failure_assertion="location:${expected_location}"
      elif [[ "${require_security_headers}" -eq 1 ]]; then
        if ! maxim_public_nginx_header_matches \
          "${headers}" "strict-transport-security" "max-age=31536000" prefix; then
          failure_assertion="header:strict-transport-security"
        elif ! maxim_public_nginx_header_matches \
          "${headers}" "x-content-type-options" "nosniff" exact; then
          failure_assertion="header:x-content-type-options"
        elif ! maxim_public_nginx_header_matches \
          "${headers}" "referrer-policy" "strict-origin-when-cross-origin" exact; then
          failure_assertion="header:referrer-policy"
        fi
      fi

      if [[ -z "${failure_assertion}" ]]; then
        echo "Public smoke passed: ${route}"
        return 0
      fi
    fi

    remaining_seconds=$((MAXIM_PUBLIC_NGINX_SMOKE_DEADLINE_AT - SECONDS))
    if [[ "${attempt}" -lt "${MAXIM_PUBLIC_NGINX_SMOKE_MAX_ATTEMPTS}" ]] &&
      [[ "${MAXIM_PUBLIC_NGINX_SMOKE_RETRY_DELAY_SECONDS}" -gt 0 ]] &&
      [[ "${remaining_seconds}" -gt "${MAXIM_PUBLIC_NGINX_SMOKE_RETRY_DELAY_SECONDS}" ]]; then
      sleep "${MAXIM_PUBLIC_NGINX_SMOKE_RETRY_DELAY_SECONDS}"
    fi
  done

  echo "Public nginx smoke failed: route=${route} assertion=${failure_assertion}." >&2
  return 1
}
