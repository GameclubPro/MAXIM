import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const finalizerPath = resolve(root, 'infra/scripts/vps-finalize-release-recovery.sh');

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function functionBlock(script, name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  const end = script.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `Unterminated shell function: ${name}`);
  return script.slice(start, end + 2);
}

function runSourced(body) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
export MAXIM_EXPECTED_DEPLOY_SHA=${'a'.repeat(40)}
source ${JSON.stringify(finalizerPath)}
${body}`,
    ],
    { encoding: 'utf8', cwd: root },
  );
}

test('finalizer is syntax-valid and contains no runtime lifecycle, build, or migration command', () => {
  const finalizer = read('infra/scripts/vps-finalize-release-recovery.sh');
  const normalizedFinalizer = finalizer.replace(/\\\r?\n[ \t]*/gu, ' ');
  execFileSync('bash', ['-n', finalizerPath]);

  assert.match(finalizer, /source "\$ROOT_DIR\/infra\/scripts\/lib\/deploy-lock\.sh"/u);
  assert.match(finalizer, /acquire_deploy_lock/u);
  assert.match(finalizer, /release_manifest recovery-base/u);
  assert.match(finalizer, /verify_runtime_snapshot/u);
  assert.match(finalizer, /assert_webhook_queue_fence_released/u);
  assert.match(finalizer, /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u);
  assert.match(finalizer, /release_manifest archive-transition/u);
  assert.doesNotMatch(
    normalizedFinalizer,
    /\bdocker\s+compose\b[^\n]*\b(?:up|build|run|create|start|stop|restart|kill|rm|down|pause|unpause|pull)\b/u,
  );
  assert.doesNotMatch(
    normalizedFinalizer,
    /\bdocker\s+(?:build|buildx|create|start|restart|stop|kill|rm|rmi|pull)\b/u,
  );
  assert.doesNotMatch(normalizedFinalizer, /\bdocker\s+image\s+(?:rm|pull)\b/u);
  assert.doesNotMatch(normalizedFinalizer, /\bforce-recreate\b/u);
  assert.doesNotMatch(normalizedFinalizer, /\bprisma\s+migrate\b/iu);
});

test('finalizer binds every active component to the target ref and re-proves strict smokes', () => {
  const finalizer = read('infra/scripts/vps-finalize-release-recovery.sh');
  const runtime = functionBlock(finalizer, 'inspect_service_runtime');
  const smokes = functionBlock(finalizer, 'run_strict_finalizer_smokes');
  const commit = functionBlock(finalizer, 'commit_recovered_release');
  const main = functionBlock(finalizer, 'main');

  assert.match(finalizer, /api-shared\) printf 'maxim-api:%s' "\$EXPECTED_DEPLOY_SHA"/u);
  assert.match(
    finalizer,
    /miniapp-major-static\) printf 'maxim-miniapp-major:%s' "\$EXPECTED_DEPLOY_SHA"/u,
  );
  assert.match(finalizer, /admin-static\) printf 'maxim-admin:%s' "\$EXPECTED_DEPLOY_SHA"/u);
  assert.match(runtime, /\{\{\.Config\.Image\}\}.*\{\{\.Image\}\}/u);
  assert.match(runtime, /"\$image_ref" == "\$expected_ref"/u);
  assert.match(runtime, /"\$image_id" == "\$expected_id"/u);
  assert.match(finalizer, /for service in "\$\{MAXIM_PRODUCTION_API_SERVICES\[@\]\}"/u);
  assert.match(finalizer, /commercial-ocr-runtime-inventory\.mjs/u);
  assert.match(finalizer, /MAXIM_OCR_NATIVE_SANDBOX_SERVICE/u);
  assert.match(finalizer, /maxim_topology_verify_ocr_native_sandbox_runtime/u);
  assert.match(finalizer, /reviewedAuxiliaryCount === value\.expectedAuxiliaryCount/u);

  for (const endpoint of [
    'http://127.0.0.1:3001/api/health/live',
    'http://127.0.0.1:3001/api/health/ready',
    'http://127.0.0.1:3002/api/health/live',
    'http://127.0.0.1:3002/api/health/ready',
    'http://127.0.0.1:3003/app/',
    'http://127.0.0.1:3004/',
  ]) {
    assert.match(smokes, new RegExp(endpoint.replaceAll('/', '\\/'), 'u'), endpoint);
  }
  assert.match(smokes, /"\$PUBLIC_HEALTH_URL\/api\/health\/live"/u);
  assert.match(smokes, /"\$PUBLIC_HEALTH_URL\/app\/"/u);
  assert.match(smokes, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(
    smokes,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required sandbox/u,
  );

  assert.match(commit, /for component in api-shared miniapp-major-static admin-static/u);
  assert.match(commit, /\$\{component\}\|\$\{EXPECTED_DEPLOY_SHA\}\|/u);
  assert.match(commit, /--current-manifest-file "\$RECOVERY_BASE_MANIFEST"/u);
  assert.match(commit, /--migrations-file "\$MIGRATIONS_FILE"/u);
  assert.match(commit, /release_manifest archive-transition/u);
  assert.equal([...main.matchAll(/assert_webhook_queue_fence_released/gu)].length, 2);
  assert.ok(
    main.indexOf('run_strict_finalizer_smokes') < main.lastIndexOf('verify_runtime_snapshot'),
  );
  assert.ok(
    main.lastIndexOf('verify_runtime_snapshot') < main.indexOf('capture_applied_migrations'),
  );
  assert.ok(
    main.indexOf('capture_applied_migrations') <
      main.lastIndexOf('assert_webhook_queue_fence_released'),
  );
  assert.ok(
    main.lastIndexOf('assert_webhook_queue_fence_released') <
      main.indexOf('commit_recovered_release'),
  );
  assert.match(main, /"\$runtime_after" == "\$runtime_before"/u);
  assert.match(main, /acquire_deploy_lock\n\s+trap finalizer_cleanup EXIT/u);
});

test('migration snapshot is bounded, read-only, validated, and owner-only', () => {
  const finalizer = read('infra/scripts/vps-finalize-release-recovery.sh');

  assert.match(finalizer, /mktemp \/tmp\/maxim-release-finalizer-migrations\.XXXXXX/u);
  assert.match(finalizer, /chmod 0600 "\$MIGRATIONS_FILE"/u);
  assert.match(finalizer, /MAX_MIGRATIONS_FILE_BYTES=1048576/u);
  assert.match(finalizer, /timeout --foreground --kill-after=2s "\$\{COMMAND_TIMEOUT_SEC\}s"/u);
  assert.match(finalizer, /default_transaction_read_only=on/u);
  assert.match(finalizer, /statement_timeout=5s/u);
  assert.match(finalizer, /lock_timeout=500ms/u);
  assert.match(finalizer, /max_parallel_workers_per_gather=0/u);
  assert.match(finalizer, /psql -X --no-password -v ON_ERROR_STOP=1/u);
  assert.match(
    finalizer,
    /SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;/u,
  );
  assert.match(finalizer, /\^\[0-9\]\{14\}_\[a-z0-9\]/u);

  const valid = runSourced(`
release_deploy_lock() { :; }
timeout() {
  printf '%s\\n' \\
    20260228000000_init \\
    20260301000000_add_max_message_length
}
trap finalizer_cleanup EXIT
capture_applied_migrations
printf 'mode=%s\\n' "$(stat -c '%a' "$MIGRATIONS_FILE")"
printf 'contents=%s\\n' "$(paste -sd, "$MIGRATIONS_FILE")"
`);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(
    valid.stdout,
    'mode=600\ncontents=20260228000000_init,20260301000000_add_max_message_length\n',
  );

  for (const timeoutBody of ["printf '%s\\n' invalid-name", 'return 17']) {
    const invalid = runSourced(`
release_deploy_lock() { :; }
timeout() { ${timeoutBody}; }
trap finalizer_cleanup EXIT
capture_applied_migrations
printf '%s\\n' COMMIT_REACHED
`);
    assert.notEqual(invalid.status, 0, timeoutBody);
    assert.doesNotMatch(invalid.stdout, /COMMIT_REACHED/u, timeoutBody);
  }
});

test('finalizer cleanup removes its migration snapshot and preserves the exit status', () => {
  const result = runSourced(`
release_deploy_lock() { printf '%s\\n' lock-released >&2; }
MIGRATIONS_FILE="$(mktemp /tmp/maxim-release-finalizer-cleanup.XXXXXX)"
printf '%s\\n' "$MIGRATIONS_FILE"
trap finalizer_cleanup EXIT
exit 23
`);

  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /lock-released/u);
  assert.equal(existsSync(result.stdout.trim()), false);
});

test('guarded wrapper requires exact green CI and directly verifies the synchronized checkout', () => {
  const connect = read('infra/scripts/vps-connect.sh');
  const wrapper = functionBlock(connect, 'finalize_release_recovery');
  const ci = wrapper.indexOf('node scripts/ci/assert-green.mjs "$expected_sha"');
  const finalizer = wrapper.indexOf('./infra/scripts/vps-finalize-release-recovery.sh "$branch"');
  const remoteExec = wrapper.indexOf('remote_exec "$remote_command"');

  assert.match(connect, /finalize-release-recovery \[branch\]/u);
  assert.match(connect, /finalize-release-recovery\)\n\s+finalize_release_recovery "\$@"/u);
  assert.match(wrapper, /node scripts\/ci\/assert-green\.mjs "\$expected_sha"/u);
  assert.match(wrapper, /MAXIM_EXPECTED_DEPLOY_SHA/u);
  assert.ok(ci >= 0 && ci < finalizer && finalizer < remoteExec);
  assert.equal([...wrapper.matchAll(/remote_exec "\$remote_command"/gu)].length, 1);
  assert.doesNotMatch(wrapper, /vps-pull-build-up|--plan/u);
  assert.doesNotMatch(wrapper, /MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE/u);
  assert.doesNotMatch(wrapper, /MAXIM_DEPLOY_EMERGENCY_BYPASS|MAXIM_DEPLOY_EMERGENCY_REASON/u);
});

test('main proves journal, runtime, released queues, smokes, and stability before commit', () => {
  const result = runSourced(`
validate_finalizer_environment() { printf '%s\\n' validate >&2; }
acquire_deploy_lock() { printf '%s\\n' lock >&2; }
verify_synchronized_checkout() { printf '%s\\n' checkout >&2; }
resolve_recovery_base_manifest() { printf '%s\\n' journal >&2; }
resolve_target_images() { printf '%s\\n' images >&2; }
prepare_target_ocr_runtime() { printf '%s\\n' ocr-boundary >&2; }
verify_runtime_snapshot() { printf '%s\\n' runtime >&2; printf '%s' stable-runtime; }
assert_webhook_queue_fence_released() { printf '%s\\n' queues >&2; }
run_strict_finalizer_smokes() { printf '%s\\n' smokes >&2; }
wait_for_runtime_stability() { printf '%s\\n' stability >&2; }
verify_target_images_unchanged() { printf '%s\\n' image-recheck >&2; }
capture_applied_migrations() { printf '%s\\n' migrations >&2; }
verify_recovery_base_unchanged() { printf '%s\\n' journal-recheck >&2; }
commit_recovered_release() { printf '%s\\n' commit >&2; }
main main
`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stderr.trim().split('\n'), [
    'validate',
    'lock',
    'checkout',
    'journal',
    'images',
    'ocr-boundary',
    'runtime',
    'queues',
    'smokes',
    'stability',
    'image-recheck',
    'runtime',
    'migrations',
    'queues',
    'journal-recheck',
    'commit',
  ]);
});

test('main fails closed before manifest commit when any proof boundary fails', () => {
  for (const failingFunction of [
    'verify_synchronized_checkout',
    'resolve_recovery_base_manifest',
    'resolve_target_images',
    'prepare_target_ocr_runtime',
    'verify_runtime_snapshot',
    'assert_webhook_queue_fence_released',
    'run_strict_finalizer_smokes',
    'verify_target_images_unchanged',
    'capture_applied_migrations',
    'verify_recovery_base_unchanged',
  ]) {
    const result = runSourced(`
validate_finalizer_environment() { :; }
acquire_deploy_lock() { :; }
verify_synchronized_checkout() { :; }
resolve_recovery_base_manifest() { :; }
resolve_target_images() { :; }
prepare_target_ocr_runtime() { :; }
verify_runtime_snapshot() { printf '%s' stable-runtime; }
assert_webhook_queue_fence_released() { :; }
run_strict_finalizer_smokes() { :; }
wait_for_runtime_stability() { :; }
verify_target_images_unchanged() { :; }
capture_applied_migrations() { :; }
verify_recovery_base_unchanged() { :; }
commit_recovered_release() { printf '%s\\n' COMMIT_REACHED; }
${failingFunction}() { return 41; }
main main
`);

    assert.notEqual(result.status, 0, failingFunction);
    assert.doesNotMatch(result.stdout, /COMMIT_REACHED/u, failingFunction);
  }
});

test('queue release validator rejects paused, owned, incomplete, and malformed summaries', () => {
  const valid = runSourced(
    `validate_webhook_queue_status '{"queueCount":24,"pausedCount":0,"activeCount":7,"ownerPresent":false}'`,
  );
  assert.equal(valid.status, 0, valid.stderr);

  for (const summary of [
    '{"queueCount":24,"pausedCount":1,"activeCount":0,"ownerPresent":false}',
    '{"queueCount":24,"pausedCount":0,"activeCount":0,"ownerPresent":true}',
    '{"queueCount":23,"pausedCount":0,"activeCount":0,"ownerPresent":false}',
    '{"queueCount":24,"pausedCount":0,"activeCount":-1,"ownerPresent":false}',
    'not-json',
  ]) {
    const result = runSourced(`validate_webhook_queue_status ${JSON.stringify(summary)}`);
    assert.notEqual(result.status, 0, summary);
  }
});
