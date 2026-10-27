import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readCommercialAiEnv,
  patchCommercialAiEnv,
  patchCommercialAiEnvFile,
  verifyCommercialAiCompose,
  verifyCommercialAiRuntimeEnv,
  COMMERCIAL_AI_POOL_ENV_KEYS,
  readCommercialAiPoolEnv,
  resolveCommercialAiPoolEnv,
  patchCommercialAiPoolEnv,
  patchCommercialAiPoolEnvFile,
  verifyCommercialAiPoolCompose,
  verifyCommercialAiPoolRuntimeEnv,
} from './commercial-ai-rollout-state.mjs';
const key = 'COMMERCIAL_LLM_ENFORCEMENT_ENABLED';
test('only the exact flag changes; missing is off and ambiguous dotenv is refused', () => {
  const original = `TOKEN='first\n${key}=true\nlast'\nOTHER=keep\n${key}=false\n`;
  assert.equal(readCommercialAiEnv(original), 'false');
  assert.equal(patchCommercialAiEnv(original, 'true'), original.slice(0, -6) + 'true\n');
  assert.equal(readCommercialAiEnv('OTHER=keep\n'), 'false');
  assert.equal(patchCommercialAiEnv('OTHER=keep\n', 'true'), `OTHER=keep\n${key}=true\n`);
  for (const invalid of [
    `${key}=true\n${key}=false`,
    `${key}=maybe`,
    "OTHER='open",
    `${key}: true`,
  ])
    assert.throws(() => patchCommercialAiEnv(invalid, 'true'));
});
test('atomic private dotenv update preserves content and rejects symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ai-env-'));
  try {
    const path = join(directory, '.env');
    writeFileSync(path, 'TOKEN=unchanged\n', { mode: 0o600 });
    patchCommercialAiEnvFile(path, 'true');
    assert.equal(readFileSync(path, 'utf8'), `TOKEN=unchanged\n${key}=true\n`);
    const link = join(directory, 'link');
    symlinkSync(path, link);
    assert.throws(() => patchCommercialAiEnvFile(link, 'false'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('all fourteen roles must agree on the requested runtime behavior', () => {
  const services = Array.from({ length: 14 }, (_, i) => `role-${i}`);
  const config = {
    services: Object.fromEntries(
      services.map((name) => [name, { environment: { [key]: 'true' } }]),
    ),
  };
  verifyCommercialAiCompose(config, 'true', services);
  config.services[services[13]].environment[key] = 'false';
  assert.throws(() => verifyCommercialAiCompose(config, 'true', services));
  assert.throws(() => verifyCommercialAiCompose(config, 'true', services.slice(0, 13)));
  verifyCommercialAiRuntimeEnv([`${key}=true`], 'true');
  assert.throws(() => verifyCommercialAiRuntimeEnv([`${key}=true`, `${key}=false`], 'true'));
});
test('mode change follows quiescence and precedes recreation; connector preserves caller intent', () => {
  const deploy = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
  const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
  assert.ok(
    deploy.indexOf('\n  persist_commercial_ai_deploy_flag\n') >
      deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES'),
  );
  assert.ok(
    deploy.indexOf('\n  persist_commercial_ai_deploy_flag\n') <
      deploy.indexOf('  recreate_service_wave "action, publisher and retention"'),
  );
  assert.match(deploy, /verify_commercial_ai_deploy_flag/u);
  assert.match(connector, /MAXIM_COMMERCIAL_LLM_ENFORCEMENT="\$COMMERCIAL_AI_FROM_CALLER"/u);
});

const poolDefaults = { workersEnabled: 'false', enabled: 'false', policy: 'confirm-positive' };
const workersOnly = { ...poolDefaults, workersEnabled: 'true' };
const poolEnabled = { ...workersOnly, enabled: 'true' };

test('pool registration is independent of routing and partial updates retain the canonical settings', () => {
  assert.deepEqual(readCommercialAiPoolEnv('OTHER=keep\n'), poolDefaults);
  const workers = patchCommercialAiPoolEnv('OTHER=keep\n', workersOnly);
  assert.deepEqual(readCommercialAiPoolEnv(workers), workersOnly);
  assert.deepEqual(resolveCommercialAiPoolEnv(workers, { enabled: 'true' }), poolEnabled);
  assert.deepEqual(
    resolveCommercialAiPoolEnv(workers, { workersEnabled: '', enabled: '', policy: '' }),
    workersOnly,
  );
  assert.throws(() => resolveCommercialAiPoolEnv('', { enabled: 'true' }));
  assert.throws(() => resolveCommercialAiPoolEnv('', { unexpected: 'true' }));
  assert.throws(() => patchCommercialAiPoolEnv('', { ...poolDefaults, policy: 'auto' }));
  assert.throws(() =>
    resolveCommercialAiPoolEnv(patchCommercialAiPoolEnv('', poolEnabled), {
      workersEnabled: 'false',
    }),
  );
  assert.deepEqual(
    resolveCommercialAiPoolEnv(patchCommercialAiPoolEnv('', poolEnabled), {
      workersEnabled: 'false',
      enabled: 'false',
    }),
    poolDefaults,
  );
});

test('atomic pool update preserves unrelated and multiline secret bytes while refusing ambiguous settings', () => {
  const poolKey = COMMERCIAL_AI_POOL_ENV_KEYS.enabled;
  const original = `TOKEN='first\n${poolKey}=true\nlast'\n${key}=true\n`;
  const patched = patchCommercialAiPoolEnv(original, workersOnly);
  assert.ok(patched.startsWith(original));
  assert.deepEqual(readCommercialAiPoolEnv(patched), workersOnly);
  for (const invalid of [
    `${poolKey}=true\n${poolKey}=false\n`,
    `${poolKey}: false\n`,
    `${poolKey}=maybe\n`,
  ])
    assert.throws(() => patchCommercialAiPoolEnv(invalid, workersOnly));
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ai-pool-env-'));
  try {
    const path = join(directory, '.env');
    writeFileSync(path, original, { mode: 0o600 });
    patchCommercialAiPoolEnvFile(path, workersOnly);
    assert.equal(readFileSync(path, 'utf8'), patched);
    const link = join(directory, 'link');
    symlinkSync(path, link);
    assert.throws(() => patchCommercialAiPoolEnvFile(link, poolEnabled));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every API role must agree on all pool flags and duplicated runtime values are rejected', () => {
  const services = Array.from({ length: 14 }, (_, index) => `role-${index}`);
  const environment = Object.fromEntries(
    Object.entries(COMMERCIAL_AI_POOL_ENV_KEYS).map(([name, envKey]) => [
      envKey,
      poolEnabled[name],
    ]),
  );
  const compose = {
    services: Object.fromEntries(
      services.map((service) => [service, { environment: { ...environment } }]),
    ),
  };
  verifyCommercialAiPoolCompose(compose, poolEnabled, services);
  const runtime = Object.entries(environment).map(([envKey, value]) => `${envKey}=${value}`);
  verifyCommercialAiPoolRuntimeEnv(runtime, poolEnabled);
  for (const envKey of Object.values(COMMERCIAL_AI_POOL_ENV_KEYS)) {
    assert.throws(() =>
      verifyCommercialAiPoolRuntimeEnv([...runtime, `${envKey}=false`], poolEnabled),
    );
    const drifted = structuredClone(compose);
    delete drifted.services[services[13]].environment[envKey];
    assert.throws(() => verifyCommercialAiPoolCompose(drifted, poolEnabled, services));
  }
  assert.throws(() => verifyCommercialAiPoolCompose(compose, poolEnabled, services.slice(1)));
});

test('pool changes use the ordinary quiescent full API rollout and caller-only overrides', () => {
  const deploy = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
  const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
  assert.ok(
    deploy.indexOf('\n  persist_commercial_ai_pool_deploy_flags\n') >
      deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES'),
  );
  assert.ok(
    deploy.indexOf('\n  persist_commercial_ai_pool_deploy_flags\n') <
      deploy.indexOf('  recreate_service_wave "action, publisher and retention"'),
  );
  assert.match(deploy, /verify_commercial_ai_pool_deploy_flags/u);
  assert.match(
    deploy,
    /unset COMMERCIAL_LLM_POOL_WORKERS_ENABLED COMMERCIAL_LLM_POOL_ENABLED COMMERCIAL_LLM_POOL_4B_POLICY/u,
  );
  for (const [setting, caller] of [
    ['WORKERS_ENABLED', 'COMMERCIAL_AI_POOL_WORKERS_FROM_CALLER'],
    ['ENABLED', 'COMMERCIAL_AI_POOL_FROM_CALLER'],
    ['4B_POLICY', 'COMMERCIAL_AI_POOL_4B_POLICY_FROM_CALLER'],
  ])
    assert.ok(connector.includes(`MAXIM_COMMERCIAL_LLM_POOL_${setting}="$${caller}"`));
});
