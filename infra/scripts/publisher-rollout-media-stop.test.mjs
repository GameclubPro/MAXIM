import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rollout = readFileSync(
  new URL('./vps-publisher-dispatch-rollout.sh', import.meta.url),
  'utf8',
);
const mediaId = 'a'.repeat(64);
function block(name) {
  const start = rollout.indexOf(`${name}() {`);
  assert.notEqual(start, -1);
  const end = rollout.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return rollout.slice(start, end + 2);
}

function run(fixture = 'healthy', hasSandbox = true) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${block('stop_media_analysis_for_rollout')}
${block('recreate_all_api_roles')}
ROOT_DIR=/reviewed
COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
MAXIM_MEDIA_ANALYSIS_SERVICE=api-media-analysis
COMMAND_TIMEOUT_SEC=30
DOCKER_MUTATION_TIMEOUT_SEC=60
MANIFEST_IMAGE_ID=reviewed-image
EXPECTED_HAS_OCR_NATIVE_SANDBOX=${hasSandbox ? 1 : 0}
ACTION_AND_PUBLISHER_WAVE=(api-action api-publisher api-message-retention)
ADMIN_WAVE=(api-admin)
INGRESS_WAVE=(api-ingress)
MEDIA_WAVE=(api-media-analysis)
MODERATION_WAVE=(api-moderation)
ENQUEUE_WAVE=(api-enqueue)
fixture=${fixture}
media_running=true
fail() { printf '%s\n' "$*" >&2; return 1; }
maxim_require_ordinary_effect_authority() { :; }
maxim_webhook_quiesce_for_api_rollout() { printf 'quiesce\n'; }
maxim_webhook_assert_api_rollout_quiescence() {
  [[ "$fixture" != lost-fence ]] || return 21
}
timeout() {
  [[ "$1" == --foreground ]] || return 90
  [[ "$2" == --kill-after=2s || "$2" == --kill-after=5s ]] || return 90
  [[ "$3" == 30s || "$3" == 60s ]] || return 90
  shift 3
  "$@"
}
docker() {
  case "$1" in
    compose)
      [[ "$*" == 'compose --env-file .env -p infra -f infra/docker-compose.yml ps -a -q api-media-analysis' ]] || return 91
      case "$fixture" in
        missing) return 0 ;;
        malformed) printf 'short-id\n' ;;
        duplicate) printf '%s\n%s\n' '${mediaId}' '${'b'.repeat(64)}' ;;
        *) printf '%s\n' '${mediaId}' ;;
      esac ;;
    stop)
      [[ "$*" == 'stop --time 30 ${mediaId}' ]] || return 92
      printf 'stop-media\n' >&2
      [[ "$fixture" != stop-failed ]] || return 23
      [[ "$fixture" == still-running ]] || media_running=false ;;
    inspect)
      [[ "$*" == 'inspect --format {{.State.Running}} ${mediaId}' ]] || return 93
      [[ "$fixture" != inspect-failed ]] || return 24
      printf '%s\n' "$media_running" ;;
    *) return 94 ;;
  esac
}
recreate_wave() {
  printf 'wave:%s\n' "$1"
  if [[ "$1" == 'media analysis' ]]; then media_running=true; fi
}
maxim_topology_verify_ocr_native_sandbox_runtime() {
  [[ "$1" == COMPOSE_FILES && "$2" == reviewed-image ]] || return 95
  printf 'attest:%s\n' "$3"
  [[ "$fixture" != unexpected-consumer ]] || return 25
  case "$3" in
    sandbox-only) [[ "$media_running" == false ]] ;;
    with-media) [[ "$media_running" == true ]] ;;
    *) return 96 ;;
  esac
}
recreate_all_api_roles
printf 'finished\n'`,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
}

test('stops only the old media consumer before isolated attestation and starts its replacement', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, 'stop-media\n');
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'quiesce',
    'wave:action and publisher',
    'wave:admin',
    'wave:ingress',
    'attest:sandbox-only',
    'wave:media analysis',
    'attest:with-media',
    'wave:moderation',
    'wave:enqueue',
    'finished',
  ]);
});

for (const fixture of [
  'missing',
  'malformed',
  'duplicate',
  'stop-failed',
  'still-running',
  'inspect-failed',
  'lost-fence',
]) {
  test(`refuses further waves when media stop proof is ${fixture}`, () => {
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stdout,
      /attest:|wave:media analysis|wave:moderation|wave:enqueue|finished/u,
    );
  });
}

test('keeps the IPC consumer guard authoritative after the owned media consumer stops', () => {
  const result = run('unexpected-consumer');
  assert.equal(result.status, 25, result.stderr);
  assert.equal(result.stderr, 'stop-media\n');
  assert.match(result.stdout, /attest:sandbox-only/u);
  assert.doesNotMatch(result.stdout, /wave:media analysis|wave:moderation|wave:enqueue|finished/u);
});

test('does not stop media or invoke OCR attestation for a runtime without that auxiliary', () => {
  const result = run('healthy', false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /attest:/u);
  assert.match(result.stdout, /wave:media analysis[\s\S]*wave:enqueue[\s\S]*finished/u);
});
