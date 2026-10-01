import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  return spawnSync('bash', ['-c', `source infra/scripts/lib/deploy-topology.sh\n${script}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
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
  for (const testCase of ['valid', 'stale', 'duplicate']) {
    const result = probe(
      `
export MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE=baseline
docker() {
  if [[ "$1" == compose ]]; then printf '%s' "\${*: -1}"; return 0; fi
  if [[ "$1" == inspect ]]; then
    printf '%s\\n' 'COMMERCIAL_OCR_VERSION=tesseract-rus-eng-v2' 'COMMERCIAL_OCR_CANARY_CHAT_IDS='
    if [[ "\${*: -1}" == api-action && "$OCR_TEST_CASE" == stale ]]; then
      printf '%s\\n' 'COMMERCIAL_OCR_ROLLOUT_MODE=private-invalid-mode'
    else printf '%s\\n' 'COMMERCIAL_OCR_ROLLOUT_MODE=baseline'; fi
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
      { OCR_TEST_CASE: testCase },
    );
    assert.equal(result.status, testCase === 'valid' ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /private-invalid-mode/u);
  }
});

test('activation persists only after journal, producer quiescence and media stop; rollback keeps v5 fence', () => {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const persist = deploy.indexOf('patch-rollout-env .env baseline');
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
