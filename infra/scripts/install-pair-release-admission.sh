#!/usr/bin/env bash
set -euo pipefail
export GIT_NO_REPLACE_OBJECTS=1

# FLAG: Stream this reviewed installer over stdin. It advances only quiescent clean source;
# it never starts runtime or target-owned release code, and never replaces a lock inode.
MAJOR_ROOT=/var/www/Chat_bot
KARAVAN_ROOT=/var/www/max-delivery-platform
ADMISSION_ROOT=/var/lib/major-karavan-release
MODE="${1:-}"
OPERATOR="${2:-}"
MAJOR_SHA="${3:-}"
KARAVAN_SHA="${4:-}"
STAGE="${5:-}"
if [[ ! "$OPERATOR" =~ ^[a-z_][a-z0-9_-]{0,31}$ || "$MODE" != install && "$MODE" != verify ]]; then exit 2; fi
if [[ "$MODE" == install ]]; then
  [[ "$#" == 5 && "$MAJOR_SHA" =~ ^[a-f0-9]{40}$ && "$KARAVAN_SHA" =~ ^[a-f0-9]{40}$ && "$STAGE" =~ ^/tmp/major-karavan-admission\.[A-Za-z0-9]{8}$ ]] || exit 2
else
  [[ "$#" == 2 ]] || exit 2
fi
[[ "$EUID" == 0 ]] || { echo 'The admission installer requires root.' >&2; exit 1; }
operator_uid="$(id -u "$OPERATOR")"
[[ "$operator_uid" != 0 ]] || exit 1
for root in "$MAJOR_ROOT" "$KARAVAN_ROOT"; do [[ -d "$root" && ! -L "$root" ]] || exit 1; done
if [[ "$MODE" == verify ]]; then
  runuser -u "$OPERATOR" -- bash "$ADMISSION_ROOT/admission.sh" verify
  cmp -s "$MAJOR_ROOT/infra/scripts/lib/pair-release-admission.sh" "$ADMISSION_ROOT/admission.sh"
  cmp -s "$KARAVAN_ROOT/infra/scripts/pair-release-admission.sh" "$ADMISSION_ROOT/admission.sh"
  cmp -s "$MAJOR_ROOT/infra/scripts/pair-release-state.mjs" "$ADMISSION_ROOT/state.mjs"
  cmp -s "$KARAVAN_ROOT/infra/scripts/pair-release-state.mjs" "$ADMISSION_ROOT/state.mjs"
  runuser -u "$OPERATOR" -- bash "$ADMISSION_ROOT/admission.sh" state
  exit
fi
[[ -d "$STAGE" && ! -L "$STAGE" && "$(stat -c '%u:%a' "$STAGE")" == "$operator_uid:700" ]] || exit 1
if pgrep -f '[v]ps-pull-build-up.sh|[v]ps-runtime-rollback.sh|[r]elease-karavan.sh|[v]ps-deploy-karavan.sh' >/dev/null; then
  echo 'A release wrapper remains active; finish it before installing into its checkout.' >&2; exit 1
fi
bootstrap_resume=0
bootstrap_owner="$ADMISSION_ROOT/state/admission.owner"
bootstrap_value() {
  awk -F= -v key="$1" '$1==key { count++; value=substr($0,index($0,"=")+1) } END { if(count!=1) exit 1; print value }' "$bootstrap_owner"
}
bootstrap_sync() {
  node -e 'const fs = require("node:fs"); for (const path of process.argv.slice(1)) { const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }' "$@"
}
if [[ -e "$ADMISSION_ROOT" || -L "$ADMISSION_ROOT" ]]; then
  # FLAG: An interrupted initial bootstrap can have storage but no installed helper yet.
  [[ -d "$ADMISSION_ROOT" && ! -L "$ADMISSION_ROOT" && "$(stat -c '%u:%a' "$ADMISSION_ROOT")" == "$EUID:755" \
    && -d "$ADMISSION_ROOT/state" && ! -L "$ADMISSION_ROOT/state" && "$(stat -c '%u:%a' "$ADMISSION_ROOT/state")" == "$operator_uid:700" \
    && -f "$ADMISSION_ROOT/state/admission.lock" && ! -L "$ADMISSION_ROOT/state/admission.lock" \
    && "$(stat -c '%u:%a:%h' "$ADMISSION_ROOT/state/admission.lock")" == "$operator_uid:600:1" ]] || exit 70
  exec 7<>"$ADMISSION_ROOT/state/admission.lock"
  flock -n 7 || { echo 'Pair admission is busy.' >&2; exit 75; }
  if [[ -e "$bootstrap_owner" || -L "$bootstrap_owner" ]]; then
    [[ -f "$bootstrap_owner" && ! -L "$bootstrap_owner" && "$(stat -c '%u:%a:%h' "$bootstrap_owner")" == "$operator_uid:600:1" \
      && "$(bootstrap_value protocol)" == major-karavan-release-v1 && "$(bootstrap_value mode)" == bootstrap \
      && "$(bootstrap_value target)" == "$MAJOR_SHA" && "$(bootstrap_value karavan_target)" == "$KARAVAN_SHA" ]] || { echo 'The previous admission owner needs reconciliation, or different bootstrap targets were selected.' >&2; exit 70; }
    node --input-type=module - "$(bootstrap_value pid)" "$(bootstrap_value start)" "$(bootstrap_value boot)" <<'NODE'
import { readFileSync } from 'node:fs';
const [pid, start, boot] = process.argv.slice(2);
if (!/^[1-9][0-9]*$/u.test(pid) || !/^[0-9]+$/u.test(start) || !/^[a-f0-9-]{36}$/u.test(boot)) throw new Error('Invalid bootstrap process identity');
try {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  if (fields[0] !== 'Z' && fields[19] === start && readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() === boot) throw new Error('Bootstrap owner is still alive');
} catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
NODE
    bootstrap_resume=1
    bootstrap_owner_sha="$(sha256sum "$bootstrap_owner" | cut -d' ' -f1)"
  fi
fi
for item in /var/lib/maxim-deploy/deploy.lock "$KARAVAN_ROOT/var/ops/karavan-production-operation.lock"; do
  [[ -f "$item" && ! -L "$item" && "$(stat -c '%h' "$item")" == 1 ]] || exit 1
done
exec 9<>/var/lib/maxim-deploy/deploy.lock
flock -n 9 || { echo 'Major product lock is busy.' >&2; exit 75; }
exec 8<>"$KARAVAN_ROOT/var/ops/karavan-production-operation.lock"
flock -n 8 || { echo 'Karavan product lock is busy.' >&2; exit 75; }
declare -A source_before_sha source_before_branch

prepare_target() {
  local name="$1" root="$2" target="$3" current changed current_branch
  current_branch="$(runuser -u "$OPERATOR" -- git -C "$root" branch --show-current)"
  [[ "$current_branch" == main || "$name" == karavan && -z "$current_branch" ]] || { echo 'Bootstrap requires Major main and Karavan main or its clean detached release checkout.' >&2; return 1; }
  [[ -z "$(runuser -u "$OPERATOR" -- git -C "$root" status --porcelain)" ]] || { echo 'Bootstrap preserves changed production source.' >&2; return 1; }
  current="$(runuser -u "$OPERATOR" -- git -C "$root" rev-parse HEAD)"
  source_before_sha[$name]="$current"
  source_before_branch[$name]="$current_branch"
  if [[ "$bootstrap_resume" == 1 ]]; then
    [[ ( "$current" == "$(bootstrap_value "${name}_before")" || "$current" == "$target" ) \
      && "$current_branch" == "$(bootstrap_value "${name}_branch")" ]] || { echo 'Production source no longer matches the reserved bootstrap.' >&2; return 70; }
  fi
  if [[ "$current" != "$target" ]]; then
    [[ -f "$STAGE/$name.bundle" && ! -L "$STAGE/$name.bundle" ]] || return 1
    runuser -u "$OPERATOR" -- git -C "$root" -c core.hooksPath=/dev/null fetch --no-tags "$STAGE/$name.bundle" refs/heads/main
    [[ "$(runuser -u "$OPERATOR" -- git -C "$root" rev-parse FETCH_HEAD)" == "$target" ]] || return 1
  fi
  runuser -u "$OPERATOR" -- git -C "$root" merge-base --is-ancestor "$current" "$target"
  while IFS= read -r changed; do
    case "$changed" in
      ''|AGENTS.md|*.md|docs/*|tests/*|tools/*|scripts/agent/*|packages/contracts/test/*|infra/scripts/*test*|\
      infra/compatibility/karavan-store-profile-catalog-coverage-v1.json|infra/compatibility/karavan-transport-service-request-flow-v1.json|\
      infra/scripts/lib/deploy-lock.sh|infra/scripts/lib/pair-release-admission.sh|infra/scripts/pair-release-admission.sh|infra/scripts/pair-release-state.mjs|infra/scripts/install-pair-release-admission.sh|infra/scripts/karavan-operation-lock.sh|\
      infra/scripts/vps-connect.sh|infra/scripts/vps-pull-build-up.sh|infra/scripts/vps-install-deploy-flock.sh|infra/scripts/vps-runtime-rollback.sh|infra/scripts/vps-rollback-karavan.sh|\
      infra/scripts/vps-legacy-cold-recovery.sh|infra/scripts/vps-source-abandonment.sh|infra/scripts/vps-source-abandonment-corrective.sh|infra/scripts/vps-backlog-cancellation.sh|\
      infra/scripts/configure-karavan-api-cdn-transport.sh|infra/scripts/configure-karavan-cdn-security-headers.sh|infra/scripts/deploy-karavan-cdn-shells.sh|infra/scripts/deploy-karavan-reg-hosting.sh|infra/scripts/deploy-karavan-restricted-lte-edge.sh|\
      infra/scripts/local-backup-karavan.sh|infra/scripts/release-karavan.sh|infra/scripts/vps-apply-karavan-catalog-cleanup.sh|infra/scripts/vps-apply-nginx-karavan-origin.sh|infra/scripts/vps-apply-nginx-karavan.sh|\
      infra/scripts/vps-backup-karavan.sh|infra/scripts/vps-deploy-karavan.sh|infra/scripts/vps-gc-karavan-upload-media.sh|infra/scripts/vps-provision-karavan-upload-volume.sh|infra/scripts/vps-recover-karavan-media-authority-lock.sh|\
      infra/scripts/vps-restore-karavan.sh|infra/scripts/vps-rollback-drill-karavan.sh|infra/scripts/karavan-media-mirror.sh|infra/scripts/vps-install-karavan-ops.sh) ;;
      *) echo 'Bootstrap only synchronizes the reviewed tooling change; application changes require normal release.' >&2; return 1 ;;
    esac
  done < <(runuser -u "$OPERATOR" -- git -C "$root" diff --name-only "$current" "$target")
}
prepare_target major "$MAJOR_ROOT" "$MAJOR_SHA"
prepare_target karavan "$KARAVAN_ROOT" "$KARAVAN_SHA"
# shellcheck disable=SC2016
runuser -u "$OPERATOR" -- bash -c 'set -euo pipefail; cd "$1"; source infra/scripts/lib/deploy-lock.sh; require_market_statistics_lock_dispatch "$2"; if declare -F require_pair_release_admission_dispatch >/dev/null; then require_pair_release_admission_dispatch "$2"; fi' bootstrap "$MAJOR_ROOT" "$MAJOR_SHA"
TRUSTED_STAGE="$(mktemp -d /tmp/major-karavan-admission-root.XXXXXXXX)"
trap 'rm -rf -- "$TRUSTED_STAGE"' EXIT
for name in major karavan; do
  if [[ "$name" == major ]]; then root="$MAJOR_ROOT"; target="$MAJOR_SHA"; helper=infra/scripts/lib/pair-release-admission.sh; lock=infra/scripts/lib/deploy-lock.sh
  else root="$KARAVAN_ROOT"; target="$KARAVAN_SHA"; helper=infra/scripts/pair-release-admission.sh; lock=infra/scripts/karavan-operation-lock.sh; fi
  runuser -u "$OPERATOR" -- git -C "$root" show "$target:$helper" >"$TRUSTED_STAGE/$name-admission.sh"
  runuser -u "$OPERATOR" -- git -C "$root" show "$target:infra/scripts/pair-release-state.mjs" >"$TRUSTED_STAGE/$name-state.mjs"
  lock_source="$(runuser -u "$OPERATOR" -- git -C "$root" show "$target:$lock")"
  grep -q pair_release_admission_acquire <<<"$lock_source"
done
cmp -s "$TRUSTED_STAGE/major-admission.sh" "$TRUSTED_STAGE/karavan-admission.sh"
cmp -s "$TRUSTED_STAGE/major-state.mjs" "$TRUSTED_STAGE/karavan-state.mjs"
bash -n "$TRUSTED_STAGE/major-admission.sh"
if [[ ! -e "$ADMISSION_ROOT" ]]; then
  install -d -o root -g root -m 0755 "$ADMISSION_ROOT"
  install -d -o "$OPERATOR" -g "$(id -gn "$OPERATOR")" -m 0700 "$ADMISSION_ROOT/state"
  (umask 077; set -o noclobber; : >"$ADMISSION_ROOT/state/admission.lock")
  chown "$OPERATOR:$(id -gn "$OPERATOR")" "$ADMISSION_ROOT/state/admission.lock"
  printf '%s\n' major-karavan-release-v1 >"$ADMISSION_ROOT/protocol-v1"
  chmod 0444 "$ADMISSION_ROOT/protocol-v1"
  exec 7<>"$ADMISSION_ROOT/state/admission.lock"
  flock -n 7 || exit 75
fi
if [[ "$bootstrap_resume" == 0 ]]; then
  # FLAG: This durable owner survives failure after only one product source advances.
  # It is not a runtime token, and only this exact locked source bootstrap can retire it.
  IFS= read -r bootstrap_token </proc/sys/kernel/random/uuid
  IFS= read -r bootstrap_stat <"/proc/$$/stat"
  read -r -a bootstrap_fields <<<"${bootstrap_stat##*) }"
  IFS= read -r bootstrap_boot </proc/sys/kernel/random/boot_id
  bootstrap_temporary="$(mktemp "$ADMISSION_ROOT/state/bootstrap-owner.XXXXXXXX")"
  printf 'protocol=major-karavan-release-v1\ntoken=%s\nproduct=major\nmode=bootstrap\ntarget=%s\nkaravan_target=%s\nmajor_before=%s\nkaravan_before=%s\nmajor_branch=%s\nkaravan_branch=%s\npid=%s\nstart=%s\nboot=%s\ncwd=%s\nfd=7\ninode=%s\ninitial_state=\nstarted_at=%s\n' \
    "$bootstrap_token" "$MAJOR_SHA" "$KARAVAN_SHA" "${source_before_sha[major]}" "${source_before_sha[karavan]}" "${source_before_branch[major]}" "${source_before_branch[karavan]}" \
    "$$" "${bootstrap_fields[19]}" "$bootstrap_boot" "$(printf '%s' "$(pwd -P)" | sha256sum | cut -d' ' -f1)" "$(stat -c '%d:%i' "$ADMISSION_ROOT/state/admission.lock")" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >"$bootstrap_temporary"
  chown "$OPERATOR:$(id -gn "$OPERATOR")" "$bootstrap_temporary"
  chmod 0600 "$bootstrap_temporary"
  bootstrap_sync "$bootstrap_temporary"
  mv -T -- "$bootstrap_temporary" "$bootstrap_owner"
  bootstrap_sync "$ADMISSION_ROOT/state" "$ADMISSION_ROOT"
  bootstrap_owner_sha="$(sha256sum "$bootstrap_owner" | cut -d' ' -f1)"
fi
for input in admission.sh state.mjs; do
  temporary="$(mktemp "$ADMISSION_ROOT/$input.XXXXXXXX")"
  install -o root -g root -m 0444 "$TRUSTED_STAGE/major-$input" "$temporary"
  mv -T -- "$temporary" "$ADMISSION_ROOT/$input"
done
advance_target() {
  local name="$1" root="$2" target="$3"
  [[ "$(runuser -u "$OPERATOR" -- git -C "$root" rev-parse HEAD)" == "${source_before_sha[$name]}" \
    && "$(runuser -u "$OPERATOR" -- git -C "$root" branch --show-current)" == "${source_before_branch[$name]}" \
    && -z "$(runuser -u "$OPERATOR" -- git -C "$root" status --porcelain)" ]] || { echo 'Production source changed after bootstrap preparation.' >&2; return 1; }
  if [[ "$name" == karavan && -z "${source_before_branch[$name]}" ]]; then
    runuser -u "$OPERATOR" -- git -C "$root" -c core.hooksPath=/dev/null switch --detach "$target"
  else
    runuser -u "$OPERATOR" -- git -C "$root" -c core.hooksPath=/dev/null merge --ff-only "$target"
  fi
}
advance_target major "$MAJOR_ROOT" "$MAJOR_SHA"
advance_target karavan "$KARAVAN_ROOT" "$KARAVAN_SHA"
# FLAG: Verify both complete source outcomes before retiring the durable bootstrap fence.
[[ "$(runuser -u "$OPERATOR" -- git -C "$MAJOR_ROOT" rev-parse HEAD)" == "$MAJOR_SHA" \
  && "$(runuser -u "$OPERATOR" -- git -C "$KARAVAN_ROOT" rev-parse HEAD)" == "$KARAVAN_SHA" \
  && -z "$(runuser -u "$OPERATOR" -- git -C "$MAJOR_ROOT" status --porcelain)" \
  && -z "$(runuser -u "$OPERATOR" -- git -C "$KARAVAN_ROOT" status --porcelain)" \
  && "$(sha256sum "$bootstrap_owner" | cut -d' ' -f1)" == "$bootstrap_owner_sha" ]] || exit 70
for input in admission.sh state.mjs; do
  cmp -s "$TRUSTED_STAGE/major-$input" "$ADMISSION_ROOT/$input"
done
cmp -s "$MAJOR_ROOT/infra/scripts/lib/pair-release-admission.sh" "$ADMISSION_ROOT/admission.sh"
cmp -s "$KARAVAN_ROOT/infra/scripts/pair-release-admission.sh" "$ADMISSION_ROOT/admission.sh"
cmp -s "$MAJOR_ROOT/infra/scripts/pair-release-state.mjs" "$ADMISSION_ROOT/state.mjs"
cmp -s "$KARAVAN_ROOT/infra/scripts/pair-release-state.mjs" "$ADMISSION_ROOT/state.mjs"
# FLAG: The bootstrap holder is root; inspect its /proc identity with the same UID here.
# Final public readback below runs as the operator after that owner is retired.
bash "$ADMISSION_ROOT/admission.sh" state >/dev/null
bootstrap_archive="$ADMISSION_ROOT/state/bootstrapped"
if [[ ! -e "$bootstrap_archive" && ! -L "$bootstrap_archive" ]]; then install -d -o "$OPERATOR" -g "$(id -gn "$OPERATOR")" -m 0700 "$bootstrap_archive"; fi
[[ -d "$bootstrap_archive" && ! -L "$bootstrap_archive" && "$(stat -c '%u:%a' "$bootstrap_archive")" == "$operator_uid:700" \
  && ! -e "$bootstrap_archive/$bootstrap_owner_sha.owner" && ! -L "$bootstrap_archive/$bootstrap_owner_sha.owner" ]] || exit 70
mv -T -- "$bootstrap_owner" "$bootstrap_archive/$bootstrap_owner_sha.owner"
bootstrap_sync "$bootstrap_archive/$bootstrap_owner_sha.owner" "$bootstrap_archive" "$ADMISSION_ROOT/state"
runuser -u "$OPERATOR" -- bash "$ADMISSION_ROOT/admission.sh" verify
runuser -u "$OPERATOR" -- bash "$ADMISSION_ROOT/admission.sh" state
echo 'Shared admission installed; source advanced without runtime mutations or lock replacement.' >&2
