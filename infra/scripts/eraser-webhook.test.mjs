import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReleaseManifest } from './release-manifest.mjs';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

const TOOLING_SHA = 'a'.repeat(40);
const RUNTIME_SHA = 'b'.repeat(40);

function fixture(t, mode = 'success') {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-eraser-webhook-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const scripts = join(repo, 'infra/scripts');
  const lock = deployLockFixture(directory, join(scripts, 'lib/deploy-lock.sh'));
  writeFileSync(lock.file, '', { mode: 0o600 });
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const manifest = structuredClone(
    buildReleaseManifest({
      releaseId: 'installed-runtime',
      targetSha: RUNTIME_SHA,
      createdAt: '2026-10-26T00:00:00.000Z',
      components: ['api-shared', 'miniapp-major-static', 'admin-static', 'eraser']
        .filter((id) => mode !== 'missing-component' || id !== 'eraser')
        .map((id) => ({
          id,
          sourceSha: RUNTIME_SHA,
          imageRef: `maxim-${id}:${RUNTIME_SHA}`,
          imageId: `sha256:${'c'.repeat(64)}`,
        })),
    }),
  );
  if (mode === 'malformed-manifest') manifest.components.eraser.imageId = 'unknown';
  if (mode !== 'missing-manifest')
    writeFileSync(join(lock.protectedDirectory, 'current.json'), JSON.stringify(manifest));
  if (mode === 'pending-transition')
    writeFileSync(
      join(lock.protectedDirectory, 'current.invalid-deploy-20261026T000000Z-123.json'),
      JSON.stringify(manifest),
    );
  writeFileSync(
    join(scripts, 'lib/legacy-cold-maintenance.sh'),
    'maxim_require_ordinary_effect_authority() { require_deploy_lock || return; [[ "$FIXTURE_MODE" != authority-denied ]]; }\n',
  );
  for (const file of ['eraser-smoke.mjs', 'release-manifest.mjs', 'lib/eraser-deploy.sh']) {
    let source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    if (file === 'release-manifest.mjs')
      source = source.replaceAll('/var/lib/maxim-deploy', lock.protectedDirectory);
    writeFileSync(join(scripts, file), source);
  }
  const transaction = join(directory, 'transaction.sh');
  writeFileSync(
    transaction,
    readFileSync(new URL('./vps-eraser-webhook.sh', import.meta.url), 'utf8').replace(
      /^ROOT_DIR=.*$/mu,
      'ROOT_DIR="$FIXTURE_REPO"',
    ),
  );
  const events = join(directory, 'events.log');
  const prefix = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if flock -n "$FIXTURE_LOCK_FILE" true; then echo "escaped protected lock" >&2; exit 97; fi',
    'printf "%s\\n" "$*" >> "$FIXTURE_EVENTS"',
  ];
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/usr/bin/env bash',
      'if [[ "$1" == -C && ( "$2" == "$FIXTURE_PAIR_MAJOR_ROOT" || "$2" == "$FIXTURE_PAIR_KARAVAN_ROOT" ) ]]; then exec "$REAL_GIT" "$@"; fi',
      ...prefix,
      'case "$*" in',
      '  "rev-parse HEAD") if [[ "$FIXTURE_MODE" == wrong-source ]]; then printf "%s\\n" "$FIXTURE_RUNTIME_SHA"; else printf "%s\\n" "$FIXTURE_TOOLING_SHA"; fi ;;',
      '  "status --porcelain --untracked-files=all") if [[ "$FIXTURE_MODE" == dirty-source ]]; then echo "?? changed"; fi ;;',
      '  *) exit 98 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const probe = join(directory, 'health-probe.mjs');
  writeFileSync(
    probe,
    `import { assertEraserHealth } from ${JSON.stringify(join(scripts, 'eraser-smoke.mjs'))};
assertEraserHealth({ status: 'ok', service: 'eraser', enabled: true,
  commitSha: process.env.FIXTURE_MODE === 'wrong-health' ? process.env.FIXTURE_TOOLING_SHA : process.env.FIXTURE_RUNTIME_SHA }, process.argv[2]);
`,
  );
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/usr/bin/env bash',
      'if [[ "$1" == -e || "$1" == "$FIXTURE_PAIR_REPORTER" ]]; then exec "$REAL_NODE" "$@"; fi',
      ...prefix,
      'if [[ "$1" == infra/scripts/eraser-smoke.mjs ]]; then shift; exec "$REAL_NODE" "$FIXTURE_HEALTH_PROBE" "$@"; fi',
      'exec "$REAL_NODE" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'docker'),
    [
      ...prefix,
      '[[ "$*" == "compose --env-file .env -p infra -f infra/docker-compose.yml exec -T -e ERASER_WEBHOOK_URL=https://major-maksimov.ru/eraser/webhook eraser node apps/eraser/dist/register-webhook.js" ]] || exit 98',
      '[[ "$FIXTURE_MODE" != subscription-fails ]] || exit 1',
      'echo "Eraser webhook registration confirmed."',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const env = deployLockEnvironment({
    PATH: `${bin}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
    REAL_GIT: spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(),
    FIXTURE_PAIR_REPORTER: lock.pair.reporter,
    FIXTURE_PAIR_MAJOR_ROOT: lock.pair.majorRoot,
    FIXTURE_PAIR_KARAVAN_ROOT: lock.pair.karavanRoot,
    FIXTURE_REPO: repo,
    FIXTURE_TOOLING_SHA: TOOLING_SHA,
    FIXTURE_RUNTIME_SHA: RUNTIME_SHA,
    FIXTURE_HEALTH_PROBE: probe,
    FIXTURE_MODE: mode,
    FIXTURE_LOCK_FILE: lock.file,
    FIXTURE_EVENTS: events,
  });
  return {
    run: (busy = false) =>
      spawnSync(
        busy ? 'flock' : 'bash',
        busy ? ['-n', lock.file, 'bash', transaction, TOOLING_SHA] : [transaction, TOOLING_SHA],
        { env, encoding: 'utf8', timeout: 5000 },
      ),
    events: () => (existsSync(events) ? readFileSync(events, 'utf8') : ''),
    assertReleased: () => {
      const result = spawnSync('flock', ['-n', lock.file, 'true']);
      assert.equal(result.status, 0);
    },
  };
}

test('Lastik subscription checks the installed component source while tooling advances independently', (t) => {
  const h = fixture(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(h.events(), new RegExp(`eraser-smoke\\.mjs ${RUNTIME_SHA}`, 'u'));
  assert.doesNotMatch(h.events(), new RegExp(`eraser-smoke\\.mjs ${TOOLING_SHA}`, 'u'));
  assert.equal(h.events().match(/register-webhook\.js/gu)?.length, 1);
  assert.doesNotMatch(h.events(), /(?:\bup\b|\bbuild\b|\brestart\b)/u);
  h.assertReleased();
});

for (const mode of [
  'wrong-source',
  'dirty-source',
  'authority-denied',
  'missing-manifest',
  'missing-component',
  'malformed-manifest',
  'pending-transition',
  'wrong-health',
]) {
  test(`Lastik subscription refuses ${mode} before registration`, (t) => {
    const h = fixture(t, mode);
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(h.events(), /register-webhook\.js/u);
    h.assertReleased();
  });
}

test('Lastik subscription refuses a held protected lock', (t) => {
  const h = fixture(t);
  const result = h.run(true);
  assert.notEqual(result.status, 0);
  assert.equal(h.events(), '');
  h.assertReleased();
});

test('Lastik subscription failure is preserved without blindly repeating registration', (t) => {
  const h = fixture(t, 'subscription-fails');
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(h.events().match(/register-webhook\.js/gu)?.length, 1);
  h.assertReleased();
});
