import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertEraserSource,
  assertLegacyRetentionRetirementSource,
  installLegacyRetentionRetirementFloor,
  LEGACY_RETENTION_RETIREMENT_CHECKS,
  validateLegacyRetentionRetirementFloor,
} from './assert-eraser-source.mjs';
import { assertLegacyDispositionSource } from './assert-legacy-disposition-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const storePath = 'apps/api/src/message-retention/message-retention-store.service.ts';

function temporary(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-retired-retention-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('retirement floor installs once and refuses partial, linked or writable replacements', (t) => {
  const directory = temporary(t);
  const floor = resolve(directory, 'floor');
  installLegacyRetentionRetirementFloor(floor);
  const before = statSync(floor);
  installLegacyRetentionRetirementFloor(floor);
  validateLegacyRetentionRetirementFloor(floor);
  assert.equal(statSync(floor).ino, before.ino);
  assert.equal(readFileSync(floor, 'utf8'), '1\n');
  for (const [index, value] of ['', '1', '2\n', '1\nextra'].entries()) {
    const path = resolve(directory, `bad-${index}`);
    writeFileSync(path, value, { mode: 0o600 });
    assert.throws(() => installLegacyRetentionRetirementFloor(path), /retirement reader floor/u);
    assert.equal(readFileSync(path, 'utf8'), value);
  }
  chmodSync(floor, 0o644);
  assert.throws(() => installLegacyRetentionRetirementFloor(floor), /retirement reader floor/u);
  chmodSync(floor, 0o600);
  const alias = resolve(directory, 'alias');
  symlinkSync(floor, alias);
  assert.throws(() => installLegacyRetentionRetirementFloor(alias));
  linkSync(floor, resolve(directory, 'hardlink'));
  assert.throws(() => installLegacyRetentionRetirementFloor(floor));
});

test('retired API retains ownership and permanent disposition readers without the old intake', () => {
  assert.doesNotThrow(() => assertLegacyRetentionRetirementSource(sha, 'all', read));
  assert.doesNotThrow(() => assertEraserSource(sha, read));
  assert.doesNotThrow(() => assertLegacyDispositionSource(sha, read));
});

test('the installed ownership checker accepts retirement before controller re-exec', () => {
  // FLAG: Preserved installed checker from abb0ba903c70e47c86dc7d55caff9ba70871ead8.
  // Keep this fixture independent of both new checker changes and shallow Git history.
  const installedChecks = [
    [
      'apps/api/src/message-retention/eraser-control.service.ts',
      ['ERASER_OWNERSHIP_VERSION = 1', 'eraser_chat_bindings'],
    ],
    [
      'apps/api/src/message-retention/message-retention-binding.ts',
      ['eraser_chat_bindings', '"eraserOwned"'],
    ],
    [
      'apps/api/src/message-retention/message-retention-delete-guard.service.ts',
      ['binding?.eraserOwned'],
    ],
  ];
  function installedOwnershipCheck(sourceSha, readSource) {
    if (!/^[a-f0-9]{40}$/u.test(sourceSha ?? ''))
      throw new Error('Lastik rollback requires an exact source SHA.');
    for (const [path, markers] of installedChecks) {
      const source = readSource(path);
      if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker))) {
        throw new Error(`Rollback target lacks the installed Lastik ownership reader: ${path}`);
      }
    }
  }
  assert.doesNotThrow(() => installedOwnershipCheck(sha, read));
  assert.doesNotThrow(() => assertLegacyRetentionRetirementSource(sha, 'all', read));
});

test('omitting the legacy hold bootstrap reader requires proved retirement of that store', () => {
  const oldIntakeWithHolds = [
    'WebhookLegacyHoldService.forPrisma(this.prisma)',
    'await holds?.isMessageHeld(',
    'await holds?.isMemberHeld(',
    'await holds?.isGlobalUserHeld(',
  ].join('\n');
  assert.throws(
    () =>
      assertLegacyDispositionSource(sha, (path) =>
        path === storePath ? oldIntakeWithHolds : read(path),
      ),
    /lacks permanent/u,
  );
});

test('installed retirement rejects the previously enabled age executor', () => {
  const previous = (path) =>
    execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // FLAG: The fixture deliberately removes retirement from the reviewed source;
  // it remains valid after this test itself is committed on a retired branch.
  assert.throws(
    () =>
      assertLegacyRetentionRetirementSource(sha, 'api-shared', (path) =>
        path === storePath
          ? previous(path).replace(
              'LEGACY_RETENTION_EXECUTION_RETIRED = true;',
              'LEGACY_RETENTION_EXECUTION_RETIRED = false;',
            )
          : previous(path),
      ),
    /retirement/u,
  );
});

for (const [scope, checks] of Object.entries(LEGACY_RETENTION_RETIREMENT_CHECKS)) {
  for (const [path, markers] of checks) {
    for (const marker of markers) {
      test(`retirement refuses missing ${scope} capability ${path}: ${marker}`, () => {
        const source = read(path);
        const changed = source.replaceAll(marker, 'removed_retirement_capability');
        assert.notEqual(changed, source);
        assert.throws(
          () =>
            assertLegacyRetentionRetirementSource(sha, scope, (name) =>
              name === path ? changed : read(name),
            ),
          /retirement/u,
        );
      });
    }
    test(`retirement rejects commented and quoted capabilities: ${path}`, () => {
      const source = read(path);
      const hidden = path.endsWith('.sh')
        ? [
            source
              .split('\n')
              .map((line) => `# ${line}`)
              .join('\n'),
            `'${source.replaceAll("'", "'\\''")}'`,
          ]
        : [`/* ${source.replaceAll('*/', '* /')} */`, JSON.stringify(source)];
      for (const changed of hidden)
        assert.throws(
          () =>
            assertLegacyRetentionRetirementSource(sha, scope, (name) =>
              name === path ? changed : read(name),
            ),
          /retirement/u,
        );
    });
  }
}

test('retirement marker alone cannot hide restored intake, dispatch or remote reconciliation', () => {
  const mutations = [
    [storePath, (source) => source.replace('return false;', 'return true;')],
    [storePath, (source) => `${source}\nexport function captureRetentionMessage() {}\n`],
    [
      'apps/api/src/message-retention/message-retention-delete-guard.service.ts',
      (source) =>
        source.replace(
          'throw new MessageRetentionGuardError(',
          "if (process.env.ERASER_ENABLED !== 'true') return;\n    throw new MessageRetentionGuardError(",
        ),
    ],
    [
      'apps/api/src/moderation/moderation-delete-intent.service.ts',
      (source) =>
        source.replace(
          'if (intent.retentionOwned) return false;',
          'if (intent.retentionOwned) return true;',
        ),
    ],
    [
      'apps/api/src/moderation/moderation-delete-intent.service.ts',
      (source) =>
        source.replace(
          "    if (getAppRole() !== 'message-retention' && getAppRole() !== 'all') return null;",
          "    await this.verifyMessageAbsence();\n    if (getAppRole() !== 'message-retention' && getAppRole() !== 'all') return null;",
        ),
    ],
  ];
  for (const [path, mutate] of mutations) {
    const changed = mutate(read(path));
    assert.notEqual(changed, read(path));
    assert.throws(
      () =>
        assertLegacyRetentionRetirementSource(sha, 'api-shared', (name) =>
          name === path ? changed : read(name),
        ),
      /retirement/u,
    );
  }
  const enabledStore = read(storePath).replace('return false;', 'return true;');
  // FLAG: Ownership and retirement are independent floors; the real reject-only
  // ownership reader remains compatible even if a different retirement invariant drifts.
  assert.doesNotThrow(() =>
    assertEraserSource(sha, (path) => (path === storePath ? enabledStore : read(path))),
  );
  assert.throws(
    () =>
      assertLegacyDispositionSource(sha, (path) =>
        path === storePath ? enabledStore : read(path),
      ),
    /lacks permanent/u,
  );
});

test('the retirement rejection helper cannot introduce remote work or database mutation', () => {
  const path = 'apps/api/src/message-retention/message-retention-delete-guard.service.ts';
  const original = read(path);
  for (const prohibited of [
    'await this.max.deleteMessage("chat", "message");',
    'await fetch("https://example.invalid");',
    'await this.prisma.$executeRaw`DELETE FROM moderation_delete_intents`;',
    'await this.prisma.moderationDeleteIntent.updateMany({});',
  ]) {
    const changed = original.replace(
      '    const [binding] = await this.prisma.$queryRaw',
      `    ${prohibited}\n    const [binding] = await this.prisma.$queryRaw`,
    );
    assert.notEqual(changed, original);
    assert.throws(
      () =>
        assertLegacyRetentionRetirementSource(sha, 'api-shared', (name) =>
          name === path ? changed : read(name),
        ),
      /retirement/u,
    );
  }
});

test('installed floor validates before source and preserves the selected component scope', (t) => {
  const directory = temporary(t);
  const floor = resolve(directory, 'floor');
  installLegacyRetentionRetirementFloor(floor);
  const source = read('infra/scripts/lib/deploy-topology.sh');
  const start = source.indexOf('maxim_topology_require_retired_message_retention() {');
  const end = source.indexOf('\n}', start) + 2;
  const fn = source
    .slice(start, end)
    .replace('/var/lib/maxim-deploy/legacy-message-retention-retirement-version', floor);
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail\n${fn}\nnode() { printf '%s\\n' "$*"; }\nmaxim_topology_require_retired_message_retention '${sha}' api-shared`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split('\n');
  assert.match(rows[0], /--validate-retention-retirement-floor$/u);
  assert.match(rows[1], /--retention-retirement api-shared$/u);
  const refusal = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail\n${fn}\nnode() { if [[ "$*" == *--validate-retention-retirement-floor ]]; then return 47; fi; printf UNSAFE_SOURCE; }\nmaxim_topology_require_retired_message_retention '${sha}' api-shared`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(refusal.status, 47);
  assert.doesNotMatch(refusal.stdout, /UNSAFE_SOURCE/u);
});

test('ordinary API release installs retirement before writers and rollback paths retain its floor', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const install = deploy.indexOf(
    'maxim_eraser_install_retired_message_retention_floor "$TARGET_SHA"',
  );
  assert.ok(install >= 0);
  // Installation is in the selected API wave, before build/start and migrations.
  assert.match(
    deploy.slice(install - 42, install + 100),
    /if \[\[ "\$BUILD_API_IMAGE" -eq 1 \]\]; then/u,
  );
  const rollback = read('infra/scripts/vps-release-rollback.sh');
  assert.ok(
    rollback.indexOf(
      'maxim_topology_require_retired_message_retention "$API_SOURCE_SHA" api-shared',
    ) > rollback.indexOf('if [[ "$SELECT_API" -eq 1 ]]; then'),
  );
  assert.match(
    read('infra/scripts/vps-runtime-rollback.sh'),
    /maxim_topology_require_retired_message_retention "\$TARGET_FULL_SHA" all/u,
  );
  for (const boundary of [
    'maxim_topology_build_shared_api_image "$MAXIM_API_IMAGE" "$TARGET_SHA"',
    'if ! run_migrations; then',
    'recreate_service_wave "action, publisher and retention"',
  ]) {
    const at = deploy.indexOf(boundary);
    assert.ok(at > install, `${boundary} must remain after the permanent retirement floor`);
  }
});
