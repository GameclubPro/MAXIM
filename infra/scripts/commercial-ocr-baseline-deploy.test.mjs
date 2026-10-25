import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const apiRoles = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
];

function probe(script, env = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-ocr-guard-'));
  const diagnosticPath = resolve(directory, 'node.stderr');
  const statusPath = resolve(directory, 'node.status');
  writeFileSync(diagnosticPath, '', { mode: 0o600 });
  writeFileSync(statusPath, '', { mode: 0o600 });
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
node() {
  local status
  if "$OCR_TEST_NODE" "$@" 2>>"$OCR_TEST_NODE_STDERR"; then status=0; else status=$?; fi
  printf '%s\\n' "$status" >>"$OCR_TEST_NODE_STATUS"
  return "$status"
}
source infra/scripts/lib/deploy-topology.sh
${script}`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          OCR_TEST_NODE: process.execPath,
          OCR_TEST_NODE_STDERR: diagnosticPath,
          OCR_TEST_NODE_STATUS: statusPath,
        },
      },
    );
    const stderr = `${result.stderr}\n${readFileSync(diagnosticPath, 'utf8')}`;
    // FLAG: A native parser crash cannot satisfy an expected rollback refusal.
    const statuses = readFileSync(statusPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(
      statuses.every((status) => status === '0' || status === '1'),
      stderr,
    );
    assert.equal(result.error, undefined, stderr);
    assert.equal(result.signal, null, stderr);
    return { ...result, stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const sourceFixture = `
git() {
  [[ "$1" == show ]] || return 2
  local path="\${2#*:}"
  case "$path" in
    apps/api/src/moderation/commercial-ocr/*|apps/api/src/moderation/moderation-delete-intent.service.ts)
      node -e 'let s=require("node:fs").readFileSync(process.argv[1],"utf8");
        if(process.env.OLD_GUARD==="1") s=s.replace(/COMMERCIAL_OCR_DELETE_BINDING_VERSION = 5/u,"COMMERCIAL_OCR_DELETE_BINDING_VERSION = 4");
        if(process.env.NO_NATIVE_FENCE==="1") s=s.replaceAll("isLiveBaselineAuthorityVerified(","oldNativeCheck(");
        if(process.env.NO_BASELINE_EXECUTOR==="1") s=s.replace(/commercialOcrMode === \\x27baseline\\x27/u,"commercialOcrMode === legacyBaselineMode");
        process.stdout.write(s);' "$path"
      ;;
    *) return 2 ;;
  esac
}
`;

test('baseline requires v5, live native verification and an executor that recognizes baseline', () => {
  for (const env of [
    {},
    { OLD_GUARD: '1' },
    { NO_NATIVE_FENCE: '1' },
    { NO_BASELINE_EXECUTOR: '1' },
  ]) {
    const result = probe(
      `${sourceFixture}\nmaxim_topology_git_supports_commercial_ocr_baseline target`,
      env,
    );
    assert.equal(result.status, Object.keys(env).length === 0 ? 0 : 1, result.stderr);
  }
});

test('active baseline requires coherent authority and empty experimental scope across every role', () => {
  const makeConfig = (overrides = {}) =>
    JSON.stringify({
      services: Object.fromEntries(
        apiRoles.map((name) => [
          name,
          {
            environment: {
              COMMERCIAL_OCR_ROLLOUT_MODE: 'baseline',
              COMMERCIAL_OCR_CANARY_CHAT_IDS: '',
              ...overrides[name],
            },
          },
        ]),
      ),
    });
  for (const overrides of [
    {},
    { 'api-action': { COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow' } },
    { 'api-moderation': { COMMERCIAL_OCR_CANARY_CHAT_IDS: 'private-scope' } },
  ]) {
    const result = probe(
      `${sourceFixture}
docker() { printf '%s' "$OCR_TEST_CONFIG"; }
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_require_media_analysis_rollout_config compose_args target
`,
      { OCR_TEST_CONFIG: makeConfig(overrides) },
    );
    assert.equal(result.status, Object.keys(overrides).length === 0 ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /private-scope/u);
  }
});

test('post-deploy verification detects one stale or duplicate runtime mode without revealing its value', () => {
  for (const mode of ['baseline', 'off']) {
    for (const testCase of ['valid', 'stale', 'duplicate']) {
      const result = probe(
        `
export MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE="$OCR_TEST_MODE"
docker() {
  if [[ "$1" == compose ]]; then printf '%s' "\${*: -1}"; return 0; fi
  if [[ "$1" == inspect ]]; then
    printf '%s\\n' 'COMMERCIAL_OCR_VERSION=tesseract-rus-eng-v2' 'COMMERCIAL_OCR_CANARY_CHAT_IDS='
    if [[ "\${*: -1}" == api-action && "$OCR_TEST_CASE" == stale ]]; then
      printf '%s\\n' 'COMMERCIAL_OCR_ROLLOUT_MODE=private-invalid-mode'
    else printf '%s\\n' "COMMERCIAL_OCR_ROLLOUT_MODE=$OCR_TEST_MODE"; fi
    if [[ "\${*: -1}" == api-action && "$OCR_TEST_CASE" == duplicate ]]; then
      printf '%s\\n' 'COMMERCIAL_OCR_ROLLOUT_MODE=baseline'
    fi
    return 0
  fi
  return 8
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_verify_api_commercial_ocr_version compose_args tesseract-rus-eng-v2
`,
        { OCR_TEST_CASE: testCase, OCR_TEST_MODE: mode },
      );
      assert.equal(result.status, testCase === 'valid' ? 0 : 1, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /private-invalid-mode/u);
    }
  }
});

test('off requires coherent disabled authority across all fourteen roles', () => {
  for (const invalidRole of [null, 'api-action', 'api-moderation', 'api-media-analysis']) {
    const config = {
      services: Object.fromEntries(
        apiRoles.map((name) => [
          name,
          {
            environment: {
              COMMERCIAL_OCR_ROLLOUT_MODE: name === invalidRole ? 'canary' : 'off',
              COMMERCIAL_OCR_CANARY_CHAT_IDS: '',
            },
          },
        ]),
      ),
    };
    const result = probe(
      `
docker() { printf '%s' "$OCR_TEST_CONFIG"; }
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_require_media_analysis_rollout_config compose_args target
`,
      { OCR_TEST_CONFIG: JSON.stringify(config) },
    );
    assert.equal(result.status, invalidRole === null ? 0 : 1, result.stderr);
  }
});

test('off is explicit, rejects conflicting activation and selects an API release with no code diff', () => {
  for (const [baseline, off, expected, status] of [
    ['0', '0', '', 0],
    ['1', '0', 'baseline', 0],
    ['0', '1', 'off', 0],
    ['1', '1', '', 2],
    ['0', 'true', '', 2],
  ]) {
    const result = probe('maxim_topology_requested_commercial_ocr_deploy_mode', {
      MAXIM_COMMERCIAL_OCR_BASELINE: baseline,
      MAXIM_COMMERCIAL_OCR_OFF: off,
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, expected);
  }
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  const derive = deploy.slice(
    deploy.indexOf('derive_auto_services() {'),
    deploy.indexOf('\nprint_deploy_plan() {'),
  );
  const result = probe(`
${derive}
COMMERCIAL_OCR_DEPLOY_MODE=off
RETENTION_DEPLOY_MODE=''
impact_plan_selects_component() { return 1; }
derive_auto_services
printf '%s' "\${SERVICES[*]}"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'api-ingress');
});

test('activation persists only after journal, producer quiescence and media stop; rollback keeps v5 fence', () => {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const persist = deploy.indexOf('patch-rollout-env .env "$COMMERCIAL_OCR_DEPLOY_MODE"');
  assert.ok(persist > deploy.indexOf('maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES'));
  assert.ok(
    persist >
      deploy.indexOf('maxim_topology_stop_media_analysis_before_api_transition COMPOSE_FILES'),
  );
  assert.match(
    deploy.slice(persist - 250, persist),
    /maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES/u,
  );
  for (const path of [
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-release-rollback.sh',
  ]) {
    assert.match(read(path), /maxim_topology_require_commercial_ocr_baseline_guard/u);
  }
});
