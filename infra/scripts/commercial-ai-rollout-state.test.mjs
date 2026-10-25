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
