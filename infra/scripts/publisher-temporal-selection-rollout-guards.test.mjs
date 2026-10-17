import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  finishSelectionAudit,
  startSelectionAudit,
} from './publisher-temporal-selection-audit.mjs';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(import.meta.dirname, 'publisher-dispatch-rollout-state.mjs');
const auditHelper = resolve(import.meta.dirname, 'publisher-temporal-selection-audit.mjs');
const rollout = readFileSync(
  resolve(import.meta.dirname, 'vps-publisher-dispatch-rollout.sh'),
  'utf8',
);
const connect = readFileSync(resolve(import.meta.dirname, 'vps-connect.sh'), 'utf8');
const sha = 'a'.repeat(40);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function block(script, name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, name);
  const end = script.indexOf('\n}', start);
  assert.notEqual(end, -1, name);
  return script.slice(start, end + 2);
}

function shell(source, options = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n${source}`], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
}

function directory(t) {
  const path = mkdtempSync(resolve(tmpdir(), 'publisher-selection-guards-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function connector(args, ciStatus = 0, adoption = '0') {
  return shell(`
${block(connect, 'publisher_selection_command')}
ROOT_DIR=/fixture
MAXIM_DEPLOY_EMERGENCY_SKIP_CI=1
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=${quote(adoption)}
git() { printf '%s\\n' ${sha}; }
node() { printf 'ci:%s\\n' "$*"; return ${ciStatus}; }
shell_quote_args() { printf '%q ' "$@"; }
remote_exec() { printf 'remote:%s\\n' "$1"; }
publisher_selection_command ${args.map(quote).join(' ')}
`);
}

test('connector accepts only finite explicit stages and optional apply before CI or SSH', () => {
  for (const mode of ['off', 'test', '5', '25', '100']) {
    for (const apply of [[], ['--apply']]) {
      const result = connector([mode, ...apply]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`ci:/fixture/scripts/ci/assert-green.mjs ${sha}`));
      assert.match(
        result.stdout,
        new RegExp(`remote:env MAXIM_EXPECTED_DEPLOY_SHA=${sha} .* selection ${mode}`),
      );
      assert.equal(result.stdout.includes('--apply'), apply.length === 1);
    }
  }
  for (const args of [
    [],
    ['50'],
    ['on'],
    ['TEST'],
    ['test', '--force'],
    ['test', '--apply', '--apply'],
  ]) {
    const result = connector(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.doesNotMatch(result.stdout, /ci:|remote:/u);
  }
});

test('red exact-SHA CI and interrupted-release adoption block the connector without bypass', () => {
  const red = connector(['test', '--apply'], 17);
  assert.equal(red.status, 17, red.stderr);
  assert.match(red.stdout, /ci:/u);
  assert.doesNotMatch(red.stdout, /remote:/u);
  const adoption = connector(['off', '--apply'], 0, '1');
  assert.equal(adoption.status, 2);
  assert.doesNotMatch(adoption.stdout, /ci:|remote:/u);
});

test('host argument parsing preserves preview and rejects unsupported or repeated arguments', () => {
  const parse = (args) =>
    shell(`
${block(rollout, 'parse_args')}
fail() { printf '%s\\n' "$*" >&2; return 1; }
usage() { :; }
COMMAND=selection
APPLY=0
SELECTION_OPERATION=0
parse_args selection ${args.map(quote).join(' ')}
printf '%s:%s:%s\\n' "$SELECTION_OPERATION" "$DESIRED_SELECTION_MODE" "$APPLY"
`);
  assert.equal(parse(['test']).stdout, '1:test:0\n');
  assert.equal(parse(['off', '--apply']).stdout, '1:off:1\n');
  for (const args of [[], ['50'], ['test', '--apply', '--apply'], ['test', 'extra']]) {
    assert.notEqual(parse(args).status, 0, JSON.stringify(args));
  }
});

function prepare({
  mode = 'test',
  dispatch = 'true',
  configured = 'true',
  expected = sha,
  adoption = '0',
  sourceStatus = 0,
} = {}) {
  return shell(`
${block(rollout, 'read_selection_env')}
${block(rollout, 'prepare_selection_operation')}
fail() { printf '%s\\n' "$*" >&2; return 1; }
node() {
  case "$2" in
    verify-selection-source) printf 'source-check\\n' >&2; return ${sourceStatus} ;;
    read-selection-env) printf 'off\\n' ;;
    read-selection-env-configured) printf 'false\\n' ;;
    *) return 99 ;;
  esac
}
STATE_HELPER=/helper
ROOT_DIR=/fixture
EXPECTED_SELECTION_SOURCE_SHA=${quote(expected)}
MANIFEST_SOURCE_SHA=${sha}
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=${quote(adoption)}
CURRENT_ENV_STATE=${dispatch}
CURRENT_ENV_CONFIGURED=${configured}
DESIRED_SELECTION_MODE=${mode}
prepare_selection_operation
printf '%s:%s:%s:%s\\n' "$COMMAND" "$DESIRED_STATE" "$EXPECTED_SELECTION_MODE" "$CURRENT_SELECTION_CONFIGURED"
`);
}

test('host requires exact installed source and its selector wiring before choosing pause semantics', () => {
  assert.equal(prepare().stdout, 'enable:true:default-off:false\n');
  assert.equal(
    prepare({ mode: 'off', dispatch: 'false', configured: 'false' }).stdout,
    'disable:false:default-off:false\n',
  );
  for (const expected of ['', 'b'.repeat(40), 'A'.repeat(40)]) {
    const result = prepare({ expected });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /source-check/u);
  }
  assert.equal(prepare({ sourceStatus: 2 }).status, 2);
  const adoption = prepare({ adoption: '1' });
  assert.equal(adoption.status, 1);
  assert.doesNotMatch(adoption.stderr, /source-check/u);
  for (const mode of ['test', '5', '25', '100']) {
    const disabled = prepare({ mode, dispatch: 'false' });
    assert.equal(disabled.status, 1);
    assert.match(disabled.stderr, /dispatch already enabled/u);
  }
});

test('selection off requires exact disabled runtime and never takes the reconcile-only shortcut', () => {
  for (const configured of ['true', 'false']) {
    for (const drift of [false, true]) {
      const result = shell(`
${block(rollout, 'rollout_preflight')}
SELECTION_OPERATION=1
COMMAND=disable
APPLY=1
CURRENT_ENV_STATE=false
CURRENT_ENV_CONFIGURED=${configured}
DESIRED_STATE=false
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=0
EXPECTED_OCR_VERSION=fixture
MANIFEST_SOURCE_SHA=${sha}
RECONCILE_ONLY=0
verify_runtime() {
  printf 'runtime:%s\\n' "$1"
  [[ "\${3:-required}" == required ]] || return 91
  [[ "$1" == any || ${drift ? 'false' : 'true'} == true ]]
}
verify_compose_config() { printf 'compose\\n'; }
verify_preview_compose_config() { printf 'preview\\n'; }
maxim_topology_require_api_commercial_ocr_version_config() { :; }
maxim_topology_require_media_analysis_rollout_config() { :; }
require_stateful_services_ready() { :; }
rollout_preflight
printf 'reconcile:%s\\n' "$RECONCILE_ONLY"
`);
      assert.equal(result.status, drift ? 1 : 0, result.stderr);
      assert.match(
        result.stdout,
        new RegExp(`runtime:${configured === 'true' ? 'false' : 'default-false'}`),
      );
      if (drift) assert.doesNotMatch(result.stdout, /compose|preview|reconcile/u);
      else assert.match(result.stdout, /reconcile:0/u);
    }
  }
});

function ocrCompatibility({ mode = 'baseline', failure = '', phase = 'preflight' } = {}) {
  return shell(`
source infra/scripts/lib/deploy-topology.sh
${block(rollout, 'rollout_preflight')}
${block(rollout, 'apply_rollout')}
ROOT_DIR=${quote(root)}
COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
MANIFEST_SOURCE_SHA="$(command git rev-parse HEAD)"
EXPECTED_OCR_VERSION=fixture
EXPECTED_HAS_OCR_NATIVE_SANDBOX=1
SELECTION_OPERATION=1
COMMAND=enable
APPLY=0
CURRENT_ENV_STATE=true
CURRENT_ENV_CONFIGURED=true
DESIRED_STATE=true
DESIRED_SELECTION_MODE=off
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=0
MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE=inherited-invalid
RECONCILE_ONLY=0
ROLLOUT_COMPLETE=0
POST_CLEAR_REARM_REQUIRED=0
patched=0
events=()
trap 'printf "complete=%s expected=%s events=%s\\n" "$ROLLOUT_COMPLETE" "$MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE" "\${events[*]}"' EXIT
failure_active() { [[ ${quote(phase)} == preflight || "$patched" == 1 ]]; }
git() {
  [[ "$1" == show && "$2" == "$MANIFEST_SOURCE_SHA:"* ]] || return 91
  if [[ ${quote(failure)} == old-source && "$2" == *commercial-ocr-delete-guard.service.ts ]] && failure_active; then
    printf '%s\\n' 'BASELINE' 'COMMERCIAL_OCR_DELETE_BINDING_VERSION = 4 as const'
  else command git "$@"; fi
}
docker() {
  if [[ "$1" == compose && " $* " == *' config --format json '* ]]; then
    local active_failure=''
    if failure_active; then active_failure=${quote(failure)}; fi
    command node -e '
      const [mode, failure, ...roles] = process.argv.slice(1);
      const services = Object.fromEntries(roles.map(name => [name, { environment: {
        COMMERCIAL_OCR_VERSION: "fixture",
        COMMERCIAL_OCR_ROLLOUT_MODE: mode,
        COMMERCIAL_OCR_CANARY_CHAT_IDS: "",
      } }]));
      if (failure === "wrong-mode") services["api-media-analysis"].environment.COMMERCIAL_OCR_ROLLOUT_MODE = "canary";
      if (failure === "mixed-mode") services["api-action"].environment.COMMERCIAL_OCR_ROLLOUT_MODE = "shadow";
      if (failure === "canary") services["api-moderation"].environment.COMMERCIAL_OCR_CANARY_CHAT_IDS = "private-canary";
      process.stdout.write(JSON.stringify({ services }));
    ' ${quote(mode)} "$active_failure" "\${MAXIM_PRODUCTION_API_SERVICES[@]}"
  elif [[ "$1" == compose && " $* " == *' ps -q '* ]]; then
    printf '%s' "\${*: -1}"
  elif [[ "$1" == inspect ]]; then
    local runtime_mode=${quote(mode)}
    if [[ ${quote(failure)} == runtime-mode && "\${*: -1}" == api-action ]]; then runtime_mode=shadow; fi
    printf '%s\\n' 'COMMERCIAL_OCR_VERSION=fixture' 'COMMERCIAL_OCR_CANARY_CHAT_IDS=' "COMMERCIAL_OCR_ROLLOUT_MODE=$runtime_mode"
  else return 92; fi
}
fail() { printf '%s\\n' "$*" >&2; return 1; }
verify_runtime() { [[ "\${3:-required}" == required ]]; }
verify_compose_config() { :; }
verify_preview_compose_config() { :; }
require_stateful_services_ready() { events+=(stores); }
maxim_topology_require_publisher_secret_files() { :; }
read_control_status() { printf '{}'; }
control_field() { printf missing; }
maxim_require_ordinary_effect_authority() { :; }
record_selection_audit_start() { events+=(audit-start); }
record_selection_audit_finish() { events+=(audit-finish); }
arm_operator_pause() { events+=(arm); }
patch_selection_env() { patched=1; events+=(selection-patch); }
patch_dispatch_env() { return 93; }
recreate_all_api_roles() { events+=(recreate); }
wait_for_url() { :; }
wait_for_heartbeat() { :; }
maxim_webhook_resume_after_api_fence() { events+=(resume); }
run_health_smokes() { events+=(health); }
maxim_topology_smoke_media_analysis_tesseract() {
  [[ "$1" == COMPOSE_FILES && "$2" == required && "$3" == sandbox ]]
  [[ "$MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE" == ${quote(mode)} ]]
  events+=(native-smoke)
}
run_publisher_identity_probe() { events+=(identity); }
clear_operator_pause() { events+=(clear); }
wait_for_api_readiness() { :; }
rollout_preflight
events+=(preflight-complete)
if [[ ${quote(phase)} == apply ]]; then
  APPLY=1
  DESIRED_SELECTION_MODE=test
  MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE=inherited-invalid
  apply_rollout
fi
`);
}

test('real OCR deployment guard accepts shadow and strict baseline in selection preview and apply', () => {
  for (const mode of ['shadow', 'baseline']) {
    for (const phase of ['preflight', 'apply']) {
      const result = ocrCompatibility({ mode, phase });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`expected=${mode}`));
      assert.match(result.stdout, /stores preflight-complete/u);
      if (phase === 'preflight') {
        assert.match(result.stdout, /complete=0/u);
        assert.doesNotMatch(
          result.stdout,
          /audit-start|selection-patch|recreate|native-smoke|clear/u,
        );
      } else {
        assert.match(result.stdout, /complete=1/u);
        assert.match(
          result.stdout,
          /audit-start arm selection-patch recreate resume health native-smoke identity clear audit-finish/u,
        );
      }
    }
  }
});

test('real OCR guard rejects unsupported, scoped, mixed and old-source baseline before advancing', () => {
  for (const failure of ['wrong-mode', 'canary', 'mixed-mode', 'old-source']) {
    for (const phase of ['preflight', 'apply']) {
      const result = ocrCompatibility({ failure, phase });
      assert.equal(result.status, 1, `${failure}/${phase}: ${result.stderr}`);
      assert.match(result.stdout, /complete=0/u);
      assert.match(
        result.stderr,
        /unsupported or inconsistent OCR deployment mode|Target lacks strict commercial OCR baseline authority/u,
      );
      assert.doesNotMatch(result.stdout + result.stderr, /private-canary/u);
      assert.doesNotMatch(result.stdout, /recreate|native-smoke|identity|clear|audit-finish/u);
      if (phase === 'preflight')
        assert.doesNotMatch(result.stdout, /stores|audit-start|arm|selection-patch/u);
      else assert.match(result.stdout, /preflight-complete audit-start arm selection-patch/u);
    }
  }
});

test('baseline runtime mismatch remains a failure before Publisher pause release', () => {
  const result = ocrCompatibility({ failure: 'runtime-mode', phase: 'apply' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /api-action does not run with the reviewed commercial OCR baseline authority/u,
  );
  assert.match(result.stdout, /complete=0 expected=baseline/u);
  assert.match(result.stdout, /selection-patch recreate resume health/u);
  assert.doesNotMatch(result.stdout, /native-smoke|identity|clear|audit-finish/u);
});

test('atomic host patch preserves dispatch bytes and refuses every preflight value/configuration drift', (t) => {
  const dir = directory(t);
  const file = resolve(dir, '.env');
  const prefix =
    '\uFEFFOTHER="line1\nline2"\r\n  export MAX_PUBLISHER_DISPATCH_ENABLED = true \r\n';
  const execute = (contents, expectedMode = 'off', expectedConfigured = 'true') => {
    writeFileSync(file, contents, { mode: 0o600 });
    return shell(
      `
${block(rollout, 'read_dispatch_env')}
${block(rollout, 'read_dispatch_env_configured')}
${block(rollout, 'patch_selection_env')}
fail() { printf '%s\\n' "$*" >&2; return 1; }
STATE_HELPER=${quote(helper)}
CURRENT_SELECTION_MODE=${expectedMode}
CURRENT_SELECTION_CONFIGURED=${expectedConfigured}
CURRENT_ENV_STATE=true
CURRENT_ENV_CONFIGURED=true
DESIRED_SELECTION_MODE=test
patch_selection_env
printf 'expected:%s\\n' "$EXPECTED_SELECTION_MODE"
`,
      { cwd: dir },
    );
  };
  const original = `${prefix}PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=off\r\nTAIL=value`;
  const success = execute(original);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(file, 'utf8'), original.replace('ROLLOUT=off', 'ROLLOUT=test'));
  assert.match(success.stdout, /expected:test/u);
  for (const contents of [
    original.replace('ROLLOUT=off', 'ROLLOUT=5'),
    original.replace('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=off\r\n', ''),
    original.replace('= true ', '= false '),
    original.replace('  export MAX_PUBLISHER_DISPATCH_ENABLED = true \r\n', ''),
  ]) {
    const result = execute(contents);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(file, 'utf8'), contents);
  }
});

test('selection off appends only its key when dispatch is absent', (t) => {
  const dir = directory(t);
  const file = resolve(dir, '.env');
  writeFileSync(file, 'OTHER=value\r\n', { mode: 0o600 });
  const result = shell(
    `
${block(rollout, 'read_dispatch_env')}
${block(rollout, 'read_dispatch_env_configured')}
${block(rollout, 'patch_selection_env')}
fail() { return 1; }
STATE_HELPER=${quote(helper)}
CURRENT_SELECTION_MODE=off
CURRENT_SELECTION_CONFIGURED=false
CURRENT_ENV_STATE=false
CURRENT_ENV_CONFIGURED=false
DESIRED_SELECTION_MODE=off
patch_selection_env
`,
    { cwd: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(file, 'utf8'),
    'OTHER=value\r\nPUBLISHER_TEMPORAL_SELECTION_ROLLOUT=off\r\n',
  );
});

test('preview patches only a private dotenv and validates retained dispatch with the requested selection', (t) => {
  const dir = directory(t);
  const original = 'OTHER=value\n';
  writeFileSync(resolve(dir, '.env'), original, { mode: 0o600 });
  const result = shell(
    `
${block(rollout, 'verify_preview_compose_config')}
fail() { printf '%s\\n' "$*" >&2; return 1; }
STATE_HELPER=${quote(helper)}
SELECTION_OPERATION=1
CURRENT_ENV_CONFIGURED=false
DESIRED_SELECTION_MODE=off
MANIFEST_IMAGE_REF=maxim-api:${sha}
node() {
  if [[ "$2" == patch-selection-env ]]; then command node "$@"; return; fi
  [[ "$2" == verify-compose && "$3" == default-false && "$5" == off ]]
  cat >/dev/null
}
docker() {
  [[ "$MAXIM_COMPOSE_SERVICE_ENV_FILE" != .env ]]
  [[ "$(stat -c %a "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == 600 ]]
  [[ "$(command node "$STATE_HELPER" read-env-configured "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == false ]]
  [[ "$(command node "$STATE_HELPER" read-selection-env-configured "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == true ]]
  printf '{}'
}
verify_preview_compose_config false
[[ -z "$PREVIEW_ENV_FILE" ]]
`,
    { cwd: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(resolve(dir, '.env'), 'utf8'), original);
});

function apply(failAt, dispatch = 'true') {
  return shell(`
${block(rollout, 'apply_rollout')}
ROOT_DIR=/fixture
SELECTION_OPERATION=1
COMMAND=${dispatch === 'true' ? 'enable' : 'disable'}
DESIRED_STATE=${dispatch}
DESIRED_SELECTION_MODE=${dispatch === 'true' ? 'test' : 'off'}
EXPECTED_OCR_VERSION=fixture
MANIFEST_SOURCE_SHA=${sha}
RECONCILE_ONLY=0
ROLLOUT_COMPLETE=0
POST_CLEAR_REARM_REQUIRED=0
events=()
runtime_calls=0
trap 'printf "complete=%s events=%s\\n" "$ROLLOUT_COMPLETE" "\${events[*]}"' EXIT
maxim_require_ordinary_effect_authority() { :; }
record_selection_audit_start() { events+=(audit-start); [[ ${quote(failAt)} != audit-start ]]; }
record_selection_audit_finish() { events+=(audit-finish); [[ ${quote(failAt)} != audit-finish ]]; }
arm_operator_pause() { events+=(arm); }
patch_dispatch_env() { return 99; }
patch_selection_env() { events+=(selection-patch); [[ ${quote(failAt)} != patch ]]; }
verify_compose_config() { events+=(compose); [[ ${quote(failAt)} != compose ]]; }
maxim_topology_require_api_commercial_ocr_version_config() { :; }
maxim_topology_require_media_analysis_rollout_config() { :; }
recreate_all_api_roles() { events+=(all-roles); }
verify_runtime() {
  runtime_calls=$((runtime_calls + 1))
  events+=("runtime:$runtime_calls")
  [[ ${quote(failAt)} != runtime || "$runtime_calls" -ne 1 ]] &&
    [[ ${quote(failAt)} != final-runtime || "$runtime_calls" -ne 3 ]]
}
wait_for_url() { :; }
wait_for_heartbeat() { events+=("heartbeat:$1"); }
maxim_webhook_resume_after_api_fence() { events+=(webhook-resume); }
run_health_smokes() { events+=(smokes); }
maxim_topology_verify_api_commercial_ocr_version() { events+=(native-identity); }
maxim_topology_smoke_media_analysis_tesseract() { events+=(native-smoke); }
run_publisher_identity_probe() { events+=(identity); }
clear_operator_pause() { events+=(clear); }
wait_for_api_readiness() { events+=(stability); }
best_effort_rearm_operator_pause() { events+=(rearm); }
apply_rollout
`);
}

test('applied selection preserves the existing pause, all-role recreation and strict-readback ordering', () => {
  const result = apply('none');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /selection rollout complete: mode=test dispatch=true roles=14/u);
  assert.match(
    result.stdout,
    /complete=1 events=audit-start arm selection-patch compose all-roles runtime:1 heartbeat:false webhook-resume smokes runtime:2 native-identity native-smoke identity clear heartbeat:true stability runtime:3 audit-finish/u,
  );
  const disabled = apply('none', 'false');
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /mode=off dispatch=false roles=14/u);
  assert.match(disabled.stdout, /all-roles/u);
  assert.doesNotMatch(disabled.stdout, /heartbeat:true/u);
});

test('patch, compose and runtime failures cannot release the pause or claim selection completion', () => {
  for (const failure of ['patch', 'compose', 'runtime']) {
    const result = apply(failure);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /complete=0 events=audit-start arm selection-patch/u);
    assert.doesNotMatch(result.stdout, /rollout complete|clear|heartbeat:true/u);
  }
  const final = apply('final-runtime');
  assert.equal(final.status, 1, final.stderr);
  assert.match(final.stdout, /complete=0/u);
  assert.match(final.stdout, /runtime:3 rearm/u);
  assert.doesNotMatch(final.stdout, /rollout complete/u);
});

test('audit failures prevent mutation before start or success reporting after verified runtime', () => {
  const before = apply('audit-start');
  assert.equal(before.status, 1);
  assert.match(before.stdout, /complete=0 events=audit-start/u);
  assert.doesNotMatch(before.stdout, /arm|selection-patch|all-roles/u);
  const after = apply('audit-finish');
  assert.equal(after.status, 1);
  assert.match(after.stdout, /complete=0/u);
  assert.match(after.stdout, /runtime:3 audit-finish/u);
  assert.doesNotMatch(after.stdout, /rollout complete|rearm/u);
});

const auditInput = {
  sourceSha: sha,
  fromMode: 'off',
  fromConfigured: false,
  toMode: 'test',
  dispatchEnabled: true,
  dispatchConfigured: true,
};

test('durable audit retains exact transition identity and terminal runtime evidence in bounded private records', (t) => {
  const dir = directory(t);
  for (const [status, exitCode, runtimeVerified] of [
    ['completed', 0, true],
    ['failed', 1, false],
    ['failed', 1, true],
  ]) {
    const path = startSelectionAudit(dir, auditInput);
    const before = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(
      Object.fromEntries(Object.keys(auditInput).map((key) => [key, before[key]])),
      auditInput,
    );
    assert.equal(before.operation, 'selection');
    assert.equal(before.status, 'started');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(statSync(path).size <= 4096);
    finishSelectionAudit(path, status, exitCode, runtimeVerified);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(after, {
      ...before,
      status,
      exitCode,
      runtimeVerified,
      finishedAt: after.finishedAt,
    });
    assert.ok(Date.parse(after.finishedAt) >= Date.parse(before.startedAt));
    assert.throws(() => finishSelectionAudit(path, 'completed', 0, true), /terminal/u);
  }
});

test('audit refuses invalid stages, unsafe paths, oversize records and unproved successful completion', (t) => {
  const dir = directory(t);
  assert.throws(() => startSelectionAudit(dir, { ...auditInput, toMode: '50' }), /Invalid/u);
  const linkedDir = directory(t);
  symlinkSync(dir, resolve(linkedDir, 'publisher-selection-rollouts'));
  assert.throws(() => startSelectionAudit(linkedDir, auditInput), /protected directory/u);
  const path = startSelectionAudit(dir, auditInput);
  assert.throws(() => finishSelectionAudit(path, 'completed', 0, false), /Invalid/u);
  assert.throws(() => finishSelectionAudit(path, 'failed', 0, true), /Invalid/u);
  chmodSync(path, 0o644);
  assert.throws(() => finishSelectionAudit(path, 'failed', 1, false), /private record/u);
  chmodSync(path, 0o600);
  writeFileSync(path, ' '.repeat(4097));
  assert.throws(() => finishSelectionAudit(path, 'failed', 1, false), /private record/u);
});

test('shell audit wrappers round-trip exact transition fields through the actual CLI', (t) => {
  const dir = directory(t);
  const result = shell(`
${block(rollout, 'record_selection_audit_start')}
${block(rollout, 'record_selection_audit_finish')}
SELECTION_AUDIT_HELPER=${quote(auditHelper)}
RELEASE_STATE_DIR=${quote(dir)}
MANIFEST_SOURCE_SHA=${sha}
CURRENT_SELECTION_MODE=test
CURRENT_SELECTION_CONFIGURED=true
DESIRED_SELECTION_MODE=5
CURRENT_ENV_STATE=true
CURRENT_ENV_CONFIGURED=true
SELECTION_RUNTIME_VERIFIED=true
record_selection_audit_start
record_selection_audit_finish completed 0
[[ "$SELECTION_AUDIT_TERMINAL" -eq 1 ]]
`);
  assert.equal(result.status, 0, result.stderr);
  const auditDir = resolve(dir, 'publisher-selection-rollouts');
  const files = readdirSync(auditDir);
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(resolve(auditDir, files[0]), 'utf8'));
  assert.equal(record.fromMode, 'test');
  assert.equal(record.toMode, '5');
  assert.equal(record.sourceSha, sha);
  assert.equal(record.status, 'completed');
  assert.equal(record.runtimeVerified, true);
});

test('cleanup records the original failure and leaves the existing operator fence armed', (t) => {
  const dir = directory(t);
  const path = startSelectionAudit(dir, auditInput);
  const result = shell(`
${block(rollout, 'cleanup')}
${block(rollout, 'record_selection_audit_finish')}
SELECTION_AUDIT_HELPER=${quote(auditHelper)}
SELECTION_AUDIT_PATH=${quote(path)}
SELECTION_AUDIT_TERMINAL=0
SELECTION_RUNTIME_VERIFIED=false
APPLY=1
OPERATOR_PAUSE_ARMED=1
POST_CLEAR_REARM_REQUIRED=0
ROLLOUT_COMPLETE=0
PREVIEW_ENV_FILE=""
maxim_webhook_rollout_warn_if_paused() { :; }
release_deploy_lock() { :; }
set +e
(exit 7)
cleanup
`);
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /operator pause remains armed/u);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.status, 'failed');
  assert.equal(record.exitCode, 7);
  assert.equal(record.runtimeVerified, false);
});

test('selection augments existing dispatch validation for Compose and every runtime role', () => {
  for (const name of ['verify_compose_config', 'verify_runtime']) {
    const body = block(rollout, name);
    assert.match(body, /expected_state=default-false/u);
    assert.match(body, /validation=\(verify-(?:compose|runtime-env) "\$expected_state"/u);
    assert.match(body, /"\$EXPECTED_SELECTION_MODE"/u);
  }
  assert.match(block(rollout, 'verify_runtime'), /MAXIM_PRODUCTION_API_SERVICES\[@\]/u);
  assert.match(block(rollout, 'container_env_summary'), /"PUBLISHER_TEMPORAL_SELECTION_ROLLOUT"/u);
  const entrypoint = rollout.slice(rollout.lastIndexOf('parse_args "$@"'));
  assert.ok(
    entrypoint.indexOf('acquire_deploy_lock') < entrypoint.indexOf('resolve_release_fence'),
  );
  assert.ok(
    entrypoint.indexOf('resolve_release_fence') < entrypoint.indexOf('prepare_selection_operation'),
  );
  assert.ok(
    entrypoint.indexOf('prepare_selection_operation') < entrypoint.indexOf('rollout_preflight'),
  );
  assert.match(entrypoint, /prepare_selection_operation\nelse\n {2}read_selection_env/u);
});
