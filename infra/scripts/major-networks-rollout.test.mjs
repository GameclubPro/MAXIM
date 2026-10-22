import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  readMajorNetworksEnv,
  patchMajorNetworksEnv,
  verifyMajorNetworksEnvironment,
  verifyMajorNetworksCompose,
  verifyMajorNetworksSource,
  startMajorNetworksAudit,
  finishMajorNetworksAudit,
} from './major-networks-rollout-state.mjs';
import { PUBLISHER_PRODUCTION_ROLE_BY_SERVICE } from './publisher-dispatch-rollout-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(import.meta.dirname, 'major-networks-rollout-state.mjs');
const rollout = readFileSync(
  resolve(import.meta.dirname, 'vps-publisher-dispatch-rollout.sh'),
  'utf8',
);
const connect = readFileSync(resolve(import.meta.dirname, 'vps-connect.sh'), 'utf8');
const sha = 'a'.repeat(40);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
function block(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, name);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, name);
  return source.slice(start, end + 2);
}
const shell = (source, options = {}) =>
  spawnSync('bash', ['-c', `set -euo pipefail\n${source}`], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
function directory(t) {
  const path = mkdtempSync(resolve(tmpdir(), 'major-networks-rollout-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('Major networks dotenv preserves unrelated bytes and ignores key text in multiline data', () => {
  const before =
    '\uFEFFSECRET="line1\r\nMAJOR_NETWORKS_ROLLOUT=on\r\nline3"\r\nMAX_PUBLISHER_DISPATCH_ENABLED=false\r\nPUBLISHER_TEMPORAL_SELECTION_ROLLOUT=test\r\n';
  assert.deepEqual(readMajorNetworksEnv(before), { mode: 'off', configured: false });
  assert.equal(patchMajorNetworksEnv(before, 'test'), `${before}MAJOR_NETWORKS_ROLLOUT=test\r\n`);
  const configured = `${before}export MAJOR_NETWORKS_ROLLOUT = off`;
  assert.equal(patchMajorNetworksEnv(configured, 'on'), `${before}MAJOR_NETWORKS_ROLLOUT=on`);
  for (const invalid of [
    'MAJOR_NETWORKS_ROLLOUT=5',
    'MAJOR_NETWORKS_ROLLOUT="on"',
    'MAJOR_NETWORKS_ROLLOUT=on # comment',
    'MAJOR_NETWORKS_ROLLOUT=off\nexport MAJOR_NETWORKS_ROLLOUT=on',
    "OTHER='unterminated",
    'BAD=\0',
  ])
    assert.throws(() => readMajorNetworksEnv(invalid));
  assert.throws(() => patchMajorNetworksEnv('', '100'));
});

test('file patch stays private, preserves environment and rejects symlink targets', (t) => {
  const dir = directory(t),
    path = resolve(dir, '.env');
  const before = 'SECRET=preserved\nMAX_PUBLISHER_DISPATCH_ENABLED=false\n';
  writeFileSync(path, before, { mode: 0o600 });
  let result = spawnSync('node', [helper, 'patch-env', path, 'test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), `${before}MAJOR_NETWORKS_ROLLOUT=test\n`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const link = resolve(dir, 'linked.env');
  symlinkSync(path, link);
  result = spawnSync('node', [helper, 'patch-env', link, 'on'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  chmodSync(path, 0o666);
  assert.notEqual(spawnSync('node', [helper, 'patch-env', path, 'on']).status, 0);
});

test('mode verification binds every API service and image and distinguishes absent default from explicit mode', () => {
  const config = { services: {} };
  for (const [service, role] of Object.entries(PUBLISHER_PRODUCTION_ROLE_BY_SERVICE)) {
    config.services[service] = {
      image: `maxim-api:${sha}`,
      environment: { APP_SERVICE_NAME: service, APP_ROLE: role, MAJOR_NETWORKS_ROLLOUT: 'test' },
    };
  }
  verifyMajorNetworksCompose(config, 'test', `maxim-api:${sha}`);
  const env = config.services['api-admin'].environment;
  assert.throws(() => verifyMajorNetworksEnvironment(env, 'on', 'api-admin'));
  assert.throws(() => verifyMajorNetworksEnvironment(env, 'test', 'api-ingress'));
  delete env.MAJOR_NETWORKS_ROLLOUT;
  verifyMajorNetworksEnvironment(env, 'default-off', 'api-admin');
  assert.throws(() => verifyMajorNetworksCompose(config, 'test', `maxim-api:${sha}`));
  assert.throws(() => verifyMajorNetworksEnvironment(env, 'off', 'api-admin'));
});

test('installed Major source wires test admins, disabled default and Publisher exclusion', () => {
  verifyMajorNetworksSource(root);
});

test(
  'bounded stdin preserves Unicode split across pipe writes before decoding',
  { timeout: 10000 },
  async (t) => {
    const script = `import { readMajorNetworksStdinJson } from ${JSON.stringify(pathToFileURL(helper).href)};
process.stdout.write('ready\\n');
process.stdout.write(JSON.stringify(readMajorNetworksStdinJson(1024)));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
    t.after(() => child.kill());
    const output = [];
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString('utf8');
    });
    const ready = once(child.stdout, 'data');
    const closed = once(child, 'close');
    await ready;
    const value = { label: 'Сетка 🛰️', nested: { label: 'Каналы' } };
    const bytes = Buffer.from(JSON.stringify(value));
    const cuts = [bytes.indexOf(Buffer.from('С')) + 1, bytes.indexOf(Buffer.from('🛰')) + 1];
    let offset = 0;
    for (const end of cuts) {
      child.stdin.write(bytes.subarray(offset, end));
      offset = end;
      await delay(20);
    }
    child.stdin.end(bytes.subarray(offset));
    const [code] = await closed;
    assert.equal(code, 0, errors);
    assert.deepEqual(
      JSON.parse(Buffer.concat(output).toString('utf8').slice('ready\n'.length)),
      value,
    );
  },
);

test('runtime stdin fails closed for excess bytes and malformed UTF-8 without printing input', () => {
  const environment = {
    APP_SERVICE_NAME: 'api-admin',
    APP_ROLE: 'admin',
    MAJOR_NETWORKS_ROLLOUT: 'test',
  };
  const valid = Buffer.from(JSON.stringify(environment));
  assert.equal(
    spawnSync(process.execPath, [helper, 'verify-runtime-env', 'test', 'api-admin'], {
      input: valid,
    }).status,
    0,
  );
  const oversized = Buffer.from(
    JSON.stringify({ ...environment, privateValue: 'private'.repeat(10000) }),
  );
  const invalid = Buffer.concat([
    valid.subarray(0, -1),
    Buffer.from(',"privateValue":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}'),
  ]);
  for (const input of [oversized, invalid]) {
    const result = spawnSync(
      process.execPath,
      [helper, 'verify-runtime-env', 'test', 'api-admin'],
      { input, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Major networks rollout state verification failed.\n');
  }
});

test('mode audit cannot claim completion before runtime verification', (t) => {
  const dir = directory(t);
  const path = startMajorNetworksAudit(
    dir,
    sha,
    'off',
    'false',
    'test',
    'false',
    'false',
    'off',
    'false',
    'test',
    'true',
  );
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.status, 'started');
  assert.equal(record.retained.dispatch, false);
  assert.equal(record.retained.dispatchConfigured, false);
  assert.equal(record.retained.rollup, 'test');
  assert.equal(record.retained.selectionConfigured, false);
  assert.equal(record.retained.rollupConfigured, true);
  assert.equal(statSync(resolve(dir, 'major-networks-rollouts')).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => finishMajorNetworksAudit(path, 'completed', '0', 'false'));
  finishMajorNetworksAudit(path, 'completed', '0', 'true');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).runtimeVerified, true);
  assert.throws(() => finishMajorNetworksAudit(path, 'completed', '0', 'true'));
  chmodSync(resolve(dir, 'major-networks-rollouts'), 0o777);
  assert.throws(() =>
    startMajorNetworksAudit(
      dir,
      sha,
      'off',
      'false',
      'on',
      'false',
      'false',
      'off',
      'false',
      'off',
      'false',
    ),
  );
});

function connector(args, ciStatus = 0, adoption = '0') {
  return shell(`
${block(connect, 'major_networks_command')}
ROOT_DIR=/fixture
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=${quote(adoption)}
MAXIM_DEPLOY_EMERGENCY_BYPASS=1
git() { printf '%s\\n' ${sha}; }
node() { printf 'ci:%s\\n' "$*"; return ${ciStatus}; }
shell_quote_args() { printf '%q ' "$@"; }
remote_exec() { printf 'remote:%s\\n' "$1"; }
major_networks_command ${args.map(quote).join(' ')}
`);
}

test('connector validates finite modes before SSH and requires exact green CI without bypass', () => {
  for (const mode of ['off', 'test', 'on'])
    for (const apply of [[], ['--apply']]) {
      const result = connector([mode, ...apply]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`ci:/fixture/scripts/ci/assert-green.mjs ${sha}`));
      assert.match(
        result.stdout,
        new RegExp(`remote:env MAXIM_EXPECTED_DEPLOY_SHA=${sha} .* networks ${mode}`),
      );
      assert.equal(result.stdout.includes('--apply'), apply.length === 1);
    }
  for (const args of [[], ['5'], ['TEST'], ['on', '--force'], ['on', '--apply', '--apply']]) {
    const result = connector(args);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /ci:|remote:/u);
  }
  const red = connector(['test', '--apply'], 17);
  assert.equal(red.status, 17);
  assert.doesNotMatch(red.stdout, /remote:/u);
  const adoption = connector(['off', '--apply'], 0, '1');
  assert.equal(adoption.status, 2);
  assert.doesNotMatch(adoption.stdout, /ci:|remote:/u);
});

test('host parser accepts explicit networks modes without changing Publisher parser modes', () => {
  for (const mode of ['off', 'test', 'on']) {
    const result = shell(`
${block(rollout, 'parse_args')}
COMMAND=networks
APPLY=0
MODE_OPERATION=''
fail() { return 1; }
usage() { :; }
parse_args networks ${mode}
printf '%s:%s:%s' "$MODE_OPERATION" "$DESIRED_MODE" "$APPLY"
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `networks:${mode}:0`);
  }
  assert.match(block(rollout, 'recreate_all_api_roles'), /maxim_webhook_quiesce_for_api_rollout/u);
  assert.match(block(rollout, 'apply_rollout'), /run_health_smokes/u);
  assert.match(rollout, /acquire_deploy_lock/u);
});

test('networks preflight preserves disabled Publisher and still performs compose/runtime/store checks', () => {
  const result = shell(`
${block(rollout, 'rollout_preflight')}
MODE_OPERATION=networks
COMMAND=disable
CURRENT_ENV_STATE=false
CURRENT_ENV_CONFIGURED=false
DESIRED_STATE=false
APPLY=0
EXPECTED_OCR_VERSION=fixture
MANIFEST_SOURCE_SHA=${sha}
COMPOSE_FILES=()
verify_runtime() { printf 'runtime:%s\\n' "$1"; }
verify_compose_config() { printf 'compose:%s\\n' "$1"; }
verify_preview_compose_config() { printf 'preview:%s\\n' "$1"; }
maxim_topology_require_api_commercial_ocr_version_config() { :; }
maxim_topology_require_media_analysis_rollout_config() { :; }
require_stateful_services_ready() { printf 'stores\\n'; }
rollout_preflight
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime:default-false/u);
  assert.match(result.stdout, /compose:default-false/u);
  assert.match(result.stdout, /preview:false/u);
  assert.match(result.stdout, /stores/u);
  assert.doesNotMatch(result.stdout, /rollout complete/u);
});

test('real locked dotenv patch preserves all Publisher values and absent assignments and rejects drift', (t) => {
  const dir = directory(t),
    file = resolve(dir, '.env');
  const publisherHelper = resolve(import.meta.dirname, 'publisher-dispatch-rollout-state.mjs');
  for (const sibling of [
    { dispatch: undefined, selection: undefined, rollup: undefined },
    { dispatch: 'false', selection: 'off', rollup: 'off' },
    { dispatch: 'true', selection: 'test', rollup: '25' },
    { dispatch: 'false', selection: undefined, rollup: 'test' },
  ])
    for (const network of [undefined, 'off']) {
      const lines = {
        MAX_PUBLISHER_DISPATCH_ENABLED: sibling.dispatch,
        PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: sibling.selection,
        PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: sibling.rollup,
        MAJOR_NETWORKS_ROLLOUT: network,
      };
      const before = `\uFEFFOTHER="keep\nMAJOR_NETWORKS_ROLLOUT=on\n"\r\n${Object.entries(lines)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}\r\n`)
        .join('')}TAIL=preserved`;
      const execute = (contents) => {
        writeFileSync(file, contents, { mode: 0o600 });
        return shell(
          `
${block(rollout, 'mode_state_operation')}
${block(rollout, 'read_dispatch_env')}
${block(rollout, 'read_dispatch_env_configured')}
${block(rollout, 'patch_mode_env')}
fail() { printf '%s\\n' "$*" >&2; return 1; }
STATE_HELPER=${quote(publisherHelper)}
NETWORKS_STATE_HELPER=${quote(helper)}
MODE_OPERATION=networks
CURRENT_SELECTION_MODE=${sibling.selection ?? 'off'}
CURRENT_SELECTION_CONFIGURED=${sibling.selection !== undefined}
CURRENT_ROLLUP_MODE=${sibling.rollup ?? 'off'}
CURRENT_ROLLUP_CONFIGURED=${sibling.rollup !== undefined}
CURRENT_ENV_STATE=${sibling.dispatch ?? 'false'}
CURRENT_ENV_CONFIGURED=${sibling.dispatch !== undefined}
CURRENT_NETWORKS_MODE=${network ?? 'off'}
CURRENT_NETWORKS_CONFIGURED=${network !== undefined}
DESIRED_MODE=test
EXPECTED_SELECTION_MODE=unchanged-selection
EXPECTED_ROLLUP_MODE=unchanged-rollup
patch_mode_env
[[ "$EXPECTED_NETWORKS_MODE" == test && "$EXPECTED_SELECTION_MODE" == unchanged-selection && "$EXPECTED_ROLLUP_MODE" == unchanged-rollup ]]
`,
          { cwd: dir },
        );
      };
      const success = execute(before);
      assert.equal(success.status, 0, success.stderr);
      assert.equal(readFileSync(file, 'utf8'), patchMajorNetworksEnv(before, 'test'));
      const drifted =
        network === undefined
          ? `${before}\nMAJOR_NETWORKS_ROLLOUT=off\n`
          : before.replace('MAJOR_NETWORKS_ROLLOUT=off', 'MAJOR_NETWORKS_ROLLOUT=on');
      const refused = execute(drifted);
      assert.equal(refused.status, 1, refused.stderr);
      assert.equal(readFileSync(file, 'utf8'), drifted);
      for (const key of [
        'MAX_PUBLISHER_DISPATCH_ENABLED',
        'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT',
        'PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT',
      ]) {
        const drift =
          lines[key] === undefined
            ? `${before}\n${key}=${key === 'MAX_PUBLISHER_DISPATCH_ENABLED' ? 'false' : 'off'}\n`
            : before.replace(`${key}=${lines[key]}\r\n`, '');
        assert.equal(execute(drift).status, 1, key);
        assert.equal(readFileSync(file, 'utf8'), drift);
      }
    }
});

test('Major preview changes only its private dotenv and verifies retained Publisher plus requested Major mode', (t) => {
  const dir = directory(t);
  const original = 'PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT=test\nOTHER=value\n';
  writeFileSync(resolve(dir, '.env'), original, { mode: 0o600 });
  const result = shell(
    `
${block(rollout, 'mode_state_operation')}
${block(rollout, 'verify_preview_compose_config')}
fail() { printf '%s\\n' "$*" >&2; return 1; }
STATE_HELPER=${quote(resolve(import.meta.dirname, 'publisher-dispatch-rollout-state.mjs'))}
NETWORKS_STATE_HELPER=${quote(helper)}
MODE_OPERATION=networks
CURRENT_ENV_CONFIGURED=false
EXPECTED_SELECTION_MODE=default-off
EXPECTED_ROLLUP_MODE=test
DESIRED_MODE=on
MANIFEST_IMAGE_REF=maxim-api:${sha}
node() {
  if [[ "$2" == patch-env ]]; then command node "$@"; return; fi
  if [[ "$1" == "$STATE_HELPER" ]]; then
    [[ "$2" == verify-compose && "$3" == default-false && "$5" == default-off && "$6" == test ]]
  else
    [[ "$1" == "$NETWORKS_STATE_HELPER" && "$2" == verify-compose && "$3" == on ]]
  fi
  cat >/dev/null
}
docker() {
  [[ "$MAXIM_COMPOSE_SERVICE_ENV_FILE" != .env ]]
  [[ "$(stat -c %a "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == 600 ]]
  [[ "$(command node "$STATE_HELPER" read-env-configured "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == false ]]
  [[ "$(command node "$STATE_HELPER" read-selection-env-configured "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == false ]]
  [[ "$(command node "$STATE_HELPER" read-rollup-env "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == test ]]
  [[ "$(command node "$NETWORKS_STATE_HELPER" read-env "$MAXIM_COMPOSE_SERVICE_ENV_FILE")" == on ]]
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

test('Major shell audit wrappers retain complete sibling pairs through the actual CLI', (t) => {
  const dir = directory(t);
  const result = shell(`
${block(rollout, 'record_mode_audit_start')}
${block(rollout, 'record_mode_audit_finish')}
NETWORKS_STATE_HELPER=${quote(helper)}
RELEASE_STATE_DIR=${quote(dir)}
MODE_OPERATION=networks
MANIFEST_SOURCE_SHA=${sha}
CURRENT_NETWORKS_MODE=off
CURRENT_NETWORKS_CONFIGURED=false
DESIRED_MODE=test
CURRENT_ENV_STATE=false
CURRENT_ENV_CONFIGURED=false
CURRENT_SELECTION_MODE=off
CURRENT_SELECTION_CONFIGURED=false
CURRENT_ROLLUP_MODE=test
CURRENT_ROLLUP_CONFIGURED=true
MODE_RUNTIME_VERIFIED=true
record_mode_audit_start
record_mode_audit_finish completed 0
[[ "$MODE_AUDIT_TERMINAL" == 1 ]]
printf '%s' "$MODE_AUDIT_PATH"
`);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(result.stdout, 'utf8'));
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.retained, {
    dispatch: false,
    dispatchConfigured: false,
    selection: 'off',
    selectionConfigured: false,
    rollup: 'test',
    rollupConfigured: true,
  });
});

function applyNetworks(failure = 'none', dispatch = 'false') {
  return shell(`
${block(rollout, 'apply_rollout')}
ROOT_DIR=/fixture
MODE_OPERATION=networks
COMMAND=${dispatch === 'true' ? 'enable' : 'disable'}
DESIRED_STATE=${dispatch}
DESIRED_MODE=test
EXPECTED_OCR_VERSION=fixture
MANIFEST_SOURCE_SHA=${sha}
RECONCILE_ONLY=0
ROLLOUT_COMPLETE=0
POST_CLEAR_REARM_REQUIRED=0
events=()
runtime_calls=0
trap 'printf "complete=%s events=%s\\n" "$ROLLOUT_COMPLETE" "\${events[*]}"' EXIT
maxim_require_ordinary_effect_authority() { :; }
record_mode_audit_start() { events+=(audit-start); [[ ${quote(failure)} != audit-start ]]; }
record_mode_audit_finish() { events+=(audit-finish); [[ ${quote(failure)} != audit-finish ]]; }
arm_operator_pause() { events+=(arm); }
patch_dispatch_env() { return 99; }
patch_mode_env() { events+=(network-patch); [[ ${quote(failure)} != patch ]]; }
verify_compose_config() { events+=(compose); [[ ${quote(failure)} != compose ]]; }
maxim_topology_require_api_commercial_ocr_version_config() { :; }
maxim_topology_require_media_analysis_rollout_config() { :; }
recreate_all_api_roles() { events+=(all-roles); [[ ${quote(failure)} != recreate ]]; }
verify_runtime() {
  runtime_calls=$((runtime_calls + 1)); events+=("runtime:$runtime_calls")
  [[ ${quote(failure)} != runtime || "$runtime_calls" -ne 1 ]] &&
    [[ ${quote(failure)} != final-runtime || "$runtime_calls" -ne 3 ]]
}
wait_for_url() { :; }
wait_for_heartbeat() { events+=("heartbeat:$1"); }
maxim_webhook_resume_after_api_fence() { events+=(webhook-resume); }
run_health_smokes() { events+=(smokes); [[ ${quote(failure)} != smokes ]]; }
maxim_topology_verify_api_commercial_ocr_version() { events+=(native-identity); }
maxim_topology_smoke_media_analysis_tesseract() { events+=(native-smoke); }
run_publisher_identity_probe() { events+=(identity); }
clear_operator_pause() { events+=(clear); }
wait_for_api_readiness() { events+=(stability); }
best_effort_rearm_operator_pause() { events+=(rearm); }
apply_rollout
`);
}

test('Major uses the shared pause, complete role recreation, strict smokes and final readback before success', () => {
  for (const dispatch of ['false', 'true']) {
    const result = applyNetworks('none', dispatch);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Major networks rollout complete: mode=test roles=14/u);
    assert.match(
      result.stdout,
      /complete=1 events=audit-start arm network-patch compose all-roles runtime:1 heartbeat:false webhook-resume smokes runtime:2 native-identity native-smoke/u,
    );
    assert.match(
      result.stdout,
      dispatch === 'true'
        ? /identity clear heartbeat:true stability runtime:3 audit-finish/u
        : /clear heartbeat:false runtime:3 audit-finish/u,
    );
  }
  for (const failure of [
    'audit-start',
    'patch',
    'compose',
    'recreate',
    'runtime',
    'smokes',
    'final-runtime',
    'audit-finish',
  ]) {
    const result = applyNetworks(failure, 'true');
    assert.equal(result.status, 1, `${failure}: ${result.stderr}`);
    assert.match(result.stdout, /complete=0/u);
    assert.doesNotMatch(result.stdout, /rollout complete/u);
    if (failure === 'audit-start')
      assert.doesNotMatch(result.stdout, /arm|network-patch|all-roles/u);
    if (['patch', 'compose', 'recreate', 'runtime', 'smokes'].includes(failure))
      assert.doesNotMatch(result.stdout, /clear|heartbeat:true/u);
    if (failure === 'final-runtime') assert.match(result.stdout, /runtime:3 rearm/u);
  }
});
