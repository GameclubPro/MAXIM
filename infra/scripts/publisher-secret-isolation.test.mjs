import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function readServiceBlock(compose, service) {
  const match = compose.match(
    new RegExp(`\n  ${service}:\n([\\s\\S]*?)(?=\n  [a-zA-Z0-9_-]+:|\nsecrets:|\nvolumes:|$)`, 'u'),
  );
  assert.ok(match?.[1], `Missing Compose service ${service}`);
  return match[1];
}

for (const fileName of ['docker-compose.yml', 'docker-compose.scale.yml']) {
  test(`${fileName} mounts publisher credentials only in their owning roles`, () => {
    const compose = readFileSync(resolve(root, 'infra', fileName), 'utf8');
    const publisher = readServiceBlock(compose, 'api-publisher');
    const ingress = readServiceBlock(compose, 'api-ingress');
    const admin = readServiceBlock(compose, 'api-admin');

    assert.match(publisher, /^\s+APP_ROLE: publisher$/mu);
    assert.match(publisher, /^\s+MAX_BOT_TOKEN: ''$/mu);
    assert.match(publisher, /^\s+MAX_BOT_TOKEN_PREVIOUS: ''$/mu);
    assert.match(publisher, /^\s+MAX_BOTS_JSON: ''$/mu);
    assert.match(publisher, /^\s+- max_publisher_bot_token$/mu);
    assert.match(publisher, /^\s+- max_publisher_webhook_credentials$/mu);
    assert.doesNotMatch(publisher, /max_publisher_init_data_keys/u);

    assert.match(ingress, /^\s+- max_publisher_webhook_credentials$/mu);
    assert.doesNotMatch(ingress, /max_publisher_bot_token|max_publisher_init_data_keys/u);

    assert.match(admin, /^\s+- max_publisher_init_data_keys$/mu);
    assert.doesNotMatch(admin, /max_publisher_bot_token|max_publisher_webhook_credentials/u);

    const withoutPublisher = compose.replace(`\n  api-publisher:\n${publisher}`, '');
    assert.doesNotMatch(withoutPublisher, /^\s+- max_publisher_bot_token$/mu);
  });
}

test('production secret sources stay outside the repository', () => {
  const compose = readFileSync(resolve(root, 'infra/docker-compose.yml'), 'utf8');
  for (const path of [
    '/var/lib/maxim-secrets/publik-bot-token',
    '/var/lib/maxim-secrets/publik-webhook.json',
    '/var/lib/maxim-secrets/publik-init-data-keys.json',
  ]) {
    assert.match(compose, new RegExp(`file: ${path.replaceAll('/', '\\/')}`, 'u'));
  }
});

test('publisher source credentials never enter a root Docker build context', () => {
  const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
  const exclusions = new Set(
    dockerignore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );

  for (const path of ['/token', '/publik-webhook.json', '/publik-init-data-keys.json']) {
    assert.equal(exclusions.has(path), true, `${path} must be excluded from Docker context`);
  }

  const topology = readFileSync(resolve(root, 'infra/scripts/lib/deploy-topology.sh'), 'utf8');
  const buildInputSnapshot = topology.slice(
    topology.indexOf('maxim_topology_refuse_dirty_api_build_inputs()'),
    topology.indexOf('maxim_topology_build_shared_api_image()'),
  );
  assert.doesNotMatch(
    buildInputSnapshot,
    /(?:^|\s)(?:token|publik-webhook\.json|publik-init-data-keys\.json)(?:\s|$)/u,
  );
});
