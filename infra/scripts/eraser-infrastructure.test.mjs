import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  parseEraserBootstrap,
  installEraserSecrets,
  patchEraserBridgeEnv,
} from './eraser-bootstrap.mjs';
import { assertEraserHealth } from './eraser-smoke.mjs';
import { assertEraserSource, ERASER_SOURCE_CHECKS } from './assert-eraser-source.mjs';
import { buildReleaseManifest, validateCompleteReleaseManifest } from './release-manifest.mjs';
import { buildRollbackPlan } from './release-rollback-plan.mjs';

const sha = 'a'.repeat(40);
const request = { sourceSha: sha, botId: '123456789', botToken: 'b'.repeat(64) };

test('fresh Lastik component migrates its own store before any application startup', () => {
  const script = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
  const functionBlock = (source, name) => {
    const start = source.indexOf(`${name}() {`);
    assert.notEqual(start, -1, `Missing deploy function: ${name}`);
    const end = source.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `Unterminated deploy function: ${name}`);
    return source.slice(start, end + 2);
  };
  const start = script.indexOf(
    'if contains_service eraser "${SERVICES[@]}"; then\n  # FLAG: Own additive migrations only;',
  );
  assert.notEqual(start, -1, 'Missing independent migration/start wave');
  const end = script.indexOf('\nfi', start);
  assert.notEqual(end, -1, 'Unterminated independent migration/start wave');
  const wave = script.slice(start, end + 3);
  const run = (source) =>
    spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
ROOT_DIR=/unused
SERVICES=(api-ingress eraser)
COMPOSE_FILES=(-f fixture.yml)
migrated=0
maxim_require_ordinary_effect_authority() { :; }
wait_for_service_running() { :; }
${functionBlock(source, 'contains_service')}
${functionBlock(source, 'validate_nonnegative_int')}
${functionBlock(source, 'recreate_service_wave')}
${functionBlock(source, 'ensure_requested_services_running')}
docker() {
  case "$*" in
    *' ps --status running --services') return 0 ;;
    *' run --rm '*)
      [[ "$*" == *'--pull never eraser node apps/eraser/dist/migrate.js' ]] || return 40
      migrated=1
      printf 'MIGRATED\\n'
      ;;
    *' up -d '*)
      service="\${@: -1}"
      if [[ "$service" == eraser && "$migrated" != 1 ]]; then
        echo 'Application started before its first migration.' >&2
        return 41
      fi
      printf 'STARTED:%s\\n' "$service"
      ;;
    *) return 42 ;;
  esac
}
ensure_requested_services_running api-media-analysis
${wave}
`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
  const result = run(script);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => /^(?:MIGRATED|STARTED:)/u.test(line)),
    ['STARTED:api-ingress', 'MIGRATED', 'STARTED:eraser'],
  );
  const oldStartup = script.replace(
    '    if [[ "$service" == eraser ]]; then\n      continue\n    fi\n',
    '',
  );
  assert.notEqual(oldStartup, script, 'Missing independent startup exclusion');
  const regression = run(oldStartup);
  assert.equal(regression.status, 41);
  assert.match(regression.stderr, /before its first migration/u);
});

test('bootstrap installs bot credentials only in Lastik, preserves unrelated canonical env and refuses rotation', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'lastik-bootstrap-'));
  try {
    const secretsDir = resolve(dir, 'secrets');
    mkdirSync(secretsDir, { mode: 0o700 });
    const envPath = resolve(dir, '.env');
    const readerMarkerPath = resolve(dir, 'eraser-reader-version');
    writeFileSync(envPath, 'OTHER=value\n', { mode: 0o600 });
    installEraserSecrets(parseEraserBootstrap(JSON.stringify(request)), {
      secretsDir,
      envPath,
      sourceSha: sha,
      readerMarkerPath,
    });
    assert.equal(readFileSync(readerMarkerPath, 'utf8'), '1\n');
    assert.equal(statSync(readerMarkerPath).mode & 0o777, 0o600);
    const bridge = readFileSync(envPath, 'utf8');
    const service = readFileSync(resolve(secretsDir, 'eraser.env'), 'utf8');
    assert.match(bridge, /^OTHER=value\n/u);
    assert.match(bridge, /ERASER_ENABLED=true/u);
    assert.doesNotMatch(bridge, /ERASER_BOT_TOKEN|bbbbbbbb/u);
    assert.match(service, /ERASER_BOT_TOKEN=bbbbbbbb/u);
    assert.throws(
      () => installEraserSecrets(request, { secretsDir, envPath, sourceSha: sha }),
      /already exist/u,
    );
    assert.equal(readFileSync(envPath, 'utf8'), bridge);
    chmodSync(envPath, 0o644);
    assert.throws(
      () => installEraserSecrets(request, { secretsDir, envPath, sourceSha: sha }),
      /0600/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap rejects malformed secret requests, SHA drift and duplicate bridge keys', () => {
  for (const value of [
    { ...request, botId: 'lastik_bot' },
    { ...request, botId: '0' },
    { ...request, botId: 123 },
    { ...request, botToken: 'secret\nINJECT=true' },
    { ...request, sourceSha: 'main' },
    { ...request, extra: true },
  ]) {
    assert.throws(() => parseEraserBootstrap(JSON.stringify(value)), /Invalid/u);
  }
  assert.throws(
    () => patchEraserBridgeEnv('ERASER_ENABLED=false\nERASER_ENABLED=true\n', 'c'.repeat(64)),
    /Duplicate/u,
  );
});

test('bootstrap refuses an unknown installed reader floor before changing credentials or bridge availability', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'lastik-reader-floor-'));
  try {
    const secretsDir = resolve(dir, 'secrets');
    mkdirSync(secretsDir, { mode: 0o700 });
    const envPath = resolve(dir, '.env');
    const readerMarkerPath = resolve(dir, 'eraser-reader-version');
    writeFileSync(envPath, 'OTHER=value\n', { mode: 0o600 });
    writeFileSync(readerMarkerPath, '2\n', { mode: 0o600 });
    assert.throws(
      () =>
        installEraserSecrets(request, { secretsDir, envPath, sourceSha: sha, readerMarkerPath }),
      /reader marker/u,
    );
    assert.equal(readFileSync(envPath, 'utf8'), 'OTHER=value\n');
    assert.equal(existsSync(resolve(secretsDir, 'eraser.env')), false);
    assert.equal(existsSync(resolve(secretsDir, 'eraser-postgres-password')), false);
    assert.equal(readFileSync(readerMarkerPath, 'utf8'), '2\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Compose keeps Lastik own stores private and runtime bot credentials out of API services', () => {
  const compose = parse(readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8'));
  assert.deepEqual(compose.services['eraser-postgres'].networks, ['eraser_stores']);
  assert.deepEqual(compose.services['eraser-redis'].networks, ['eraser_stores']);
  assert.equal(compose.networks.eraser_stores.internal, true);
  assert.equal(compose.services.eraser.depends_on['eraser-postgres'].condition, 'service_healthy');
  assert.deepEqual(compose.services.eraser.ports, ['127.0.0.1:3005:3000']);
  assert.equal(compose.services.eraser.environment.ERASER_MAX_RPS, 20);
  for (const [name, service] of Object.entries(compose.services)) {
    if (!name.startsWith('api-')) continue;
    assert.ok(!JSON.stringify(service).includes('ERASER_BOT_TOKEN'), name);
    assert.ok(!JSON.stringify(service.env_file).includes('eraser.env'), name);
  }
});

test('strict health rejects a different source and store failures', () => {
  assert.doesNotThrow(() =>
    assertEraserHealth({ status: 'ok', service: 'eraser', commitSha: sha, enabled: false }, sha),
  );
  assert.throws(
    () =>
      assertEraserHealth(
        { status: 'ok', service: 'eraser', commitSha: 'b'.repeat(40), enabled: true },
        sha,
      ),
    /identity/u,
  );
  assert.throws(
    () =>
      assertEraserHealth(
        { status: 'error', service: 'eraser', commitSha: sha, enabled: true },
        sha,
      ),
    /identity/u,
  );
});

test('reader floor needs exact version and final per-chat fence, even if availability was disabled', () => {
  const sources = new Map(
    ERASER_SOURCE_CHECKS.map(([path, markers]) => [path, markers.join('\n')]),
  );
  assert.doesNotThrow(() => assertEraserSource(sha, (path) => sources.get(path)));
  for (const [path] of ERASER_SOURCE_CHECKS) {
    const before = sources.get(path);
    sources.set(path, '');
    assert.throws(() => assertEraserSource(sha, (file) => sources.get(file)), /ownership reader/u);
    sources.set(path, before);
  }
});

test('old release inventories remain valid, installed Lastik is retained and independently rolled back', () => {
  const component = (id) => ({
    id,
    sourceSha: sha,
    imageId: `sha256:${'a'.repeat(64)}`,
    imageRef: `${id === 'api-shared' ? 'maxim-api' : id === 'miniapp-major-static' ? 'maxim-miniapp-major' : id === 'eraser' ? 'maxim-eraser' : 'maxim-admin'}:${sha}`,
  });
  const old = buildReleaseManifest({
    releaseId: 'old',
    targetSha: sha,
    components: ['api-shared', 'miniapp-major-static', 'admin-static'].map(component),
  });
  assert.doesNotThrow(() => validateCompleteReleaseManifest(old));
  const installed = buildReleaseManifest({
    releaseId: 'installed',
    targetSha: sha,
    current: old,
    components: [component('eraser')],
  });
  assert.doesNotThrow(() => validateCompleteReleaseManifest(installed));
  assert.deepEqual(
    buildRollbackPlan({ manifest: installed, requestedComponents: ['eraser'] }).services,
    ['eraser'],
  );
  assert.deepEqual(
    buildRollbackPlan({ manifest: old }).components.map((c) => c.id),
    ['api-shared', 'miniapp-major-static', 'admin-static'],
  );
  assert.ok(buildRollbackPlan({ manifest: installed }).components.some((c) => c.id === 'eraser'));
});
