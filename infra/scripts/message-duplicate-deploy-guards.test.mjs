import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const paths = {
  guard: 'apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts',
  executor: 'apps/api/src/moderation/moderation-delete-intent.service.ts',
  state: 'apps/api/src/moderation/message-duplicate/message-duplicate-state.ts',
  authorization:
    'apps/api/src/moderation/message-duplicate/message-duplicate-authorization.service.ts',
  module: 'apps/api/src/moderation/message-duplicate/message-duplicate-state.module.ts',
  enforcement: 'apps/api/src/moderation/message-duplicate/message-duplicate-enforcement.service.ts',
  schema: 'apps/api/prisma/schema.prisma',
  migration:
    'apps/api/prisma/migrations/20260930180000_add_duplicate_policy_revisions/migration.sql',
  admission: 'apps/api/src/moderation/message-duplicate/message-duplicate-admission.service.ts',
  queue: 'apps/api/src/moderation/message-duplicate/message-duplicate.queue.ts',
  detector: 'apps/api/src/moderation/rule-engine-duplicate-detector.ts',
};
function probe(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-duplicate-floor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [key, path] of Object.entries(paths)) {
    if (overrides[key] === null) continue;
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, overrides[key] ?? readFileSync(resolve(root, path), 'utf8'));
  }
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() {
      if [[ "$1" != show ]]; then return 1; fi
      if [[ "$2" != target:* ]]; then return 1; fi
      cat "$MAXIM_TEST_SOURCE_ROOT/\${2#*:}"
    }
    maxim_topology_require_message_duplicate_delete_guard target
  `,
    ],
    {
      cwd: root,
      env: { ...process.env, MAXIM_TEST_ROOT: root, MAXIM_TEST_SOURCE_ROOT: directory },
      encoding: 'utf8',
    },
  );
}
test('requires the message-v3 reader, durable admission and last action permit on both rollback paths', (t) => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh']) {
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_message_duplicate_delete_guard/u,
    );
  }
  const current = probe(t);
  assert.equal(current.status, 0, current.stderr);
  const legacy = probe(t, { authorization: null });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /predates the message duplicate v3 action guard/u);
});

const mutations = [
  ['state', 'z.literal(3)', 'z.literal(4)'],
  ['state', 'text-fixed-window-unicode-near-v6', 'text-fixed-window-v5'],
  ['state', 'version: nearEnabled ?', 'version: false ?'],
  ['detector', '/[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*/gu', '/[a-zа-яё0-9]+/giu'],
  [
    'detector',
    'const gap = normalized.slice(end, until);',
    'const gap = normalized.slice(end, until).trim();',
  ],
  ['detector', 'protectedGaps.push([beforeToken, gap])', 'protectedGaps.push([0, gap])'],
  ['detector', '/[^\\p{P}\\p{Z}\\s]|[%‰‱*/\\\\^|&#@]/u.test(gap)', 'false'],
  ['detector', 'numericBoundary && /\\S/u.test(gap)', 'false'],
  [
    'detector',
    'JSON.stringify({ version: 2, tokens, numericTokens, protectedGaps })',
    'JSON.stringify({ tokens, numericTokens })',
  ],
  [
    'guard',
    'messageDuplicateSettingsDigest(settings)) !== binding.settingsDigest',
    'messageDuplicateSettingsDigest(settings)) === binding.settingsDigest',
  ],
  ['guard', 'binding.lifecycleRevision', 'binding.removedLifecycleRevision'],
  ['guard', 'settings.duplicatePolicyRevision !== binding.policyRevision', 'false'],
  ['guard', 'await this.authorization.isAllowed(chatId, binding)', 'true'],
  [
    'authorization',
    'moderationViolationMessageClaim.findUnique(',
    'moderationViolationMessageClaim.findFirst(',
  ],
  ['authorization', 'this.ordering.readActionEligibility(', 'this.ordering.unknownEligibility('],
  ['authorization', 'Date.now() >= authority.deadlineAtMs', 'false'],
  [
    'admission',
    'moderationViolationMessageClaim.createMany(',
    'moderationViolationMessageClaim.create(',
  ],
  ['admission', 'skipDuplicates: true', 'skipDuplicates: false'],
  [
    'admission',
    "created.count > 0 ? 'initial' : 'retry'",
    "created.count > 0 ? 'initial' : 'initial'",
  ],
  [
    'queue',
    'private readonly admission?: MessageDuplicateAdmissionService',
    'private readonly admission?: unknown',
  ],
  ['queue', 'await this.admission.register(', 'await this.ordering.register('],
  ['queue', "existingJob ? 'retry' : admission.registration", "existingJob ? 'retry' : 'initial'"],
  ['module', '    MessageDuplicateAdmissionService,', '    MissingAdmissionService,'],
  ['guard', 'if (params.authorityOnly)', 'if (false)'],
  [
    'enforcement',
    'await this.guard.assertQualificationAuthority(',
    'await this.guard.unknownQualificationAuthority(',
  ],
  ['enforcement', 'beforeSanctionMutation:', 'unsupportedBeforeSanctionMutation:'],
  ['executor', 'messageDuplicateEnforcementScope(binding)', 'legacyEnforcementScope(binding)'],
  [
    'executor',
    'await this.messageDuplicateDeleteGuard.assertIntentStillActionable(',
    'await this.unknownGuard.assertIntentStillActionable(',
  ],
  ['schema', 'duplicateHistoryRevision', 'unsupportedHistoryRevision'],
  ['migration', 'OLD."duplicate_policy_revision" +', 'NEW."duplicate_policy_revision" +'],
  ['migration', 'BEFORE INSERT OR UPDATE ON "chat_settings"', 'BEFORE INSERT ON "chat_settings"'],
];
for (const [key, before, after] of mutations) {
  test(`rejects rollback after removing ${key} capability ${before}`, (t) => {
    const source = readFileSync(resolve(root, paths[key]), 'utf8');
    assert.ok(source.includes(before), `Missing mutation anchor: ${before}`);
    const result = probe(t, { [key]: source.replaceAll(before, after) });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
    );
  });
}

test('rejects a guard that drops only the final authorization check after external reads', (t) => {
  const source = readFileSync(resolve(root, paths.guard), 'utf8');
  const start = source.indexOf('private async checkMessage(');
  const end = source.indexOf('\n  private ', start + 1);
  assert.ok(start >= 0 && end > start);
  const check = source.slice(start, end);
  const updated = check.replace(
    /await this\.assertAuthorization\(params\.chatId, binding\);\s*return 'allowed';/u,
    "return 'allowed';",
  );
  assert.notEqual(updated, check);
  const result = probe(t, { guard: source.slice(0, start) + updated + source.slice(end) });
  assert.notEqual(result.status, 0);
});

test('rejects removal of only the last duplicate permit fence after suggestion proof', (t) => {
  const source = readFileSync(resolve(root, paths.executor), 'utf8');
  const start = source.indexOf('const beforeImmediateDeleteMutation = async () => {');
  const end = source.indexOf('\n          };', start);
  assert.ok(start >= 0 && end > start);
  const mutation = source.slice(start, end);
  const updated = mutation.replace(
    /if \(this\.messageDuplicateDeleteGuard && intent\.messageDuplicateOwned\) \{[\s\S]*?\n {12}\}/u,
    '',
  );
  assert.notEqual(updated, mutation);
  const executor = source.slice(0, start) + updated + source.slice(end);
  assert.ok(
    executor.includes('await this.messageDuplicateDeleteGuard.assertIntentStillActionable('),
    'The earlier full duplicate guard must survive this mutation',
  );
  const result = probe(t, { executor });
  assert.notEqual(result.status, 0);
});

test('rejects a last duplicate fence that still uses remote content guards', (t) => {
  const source = readFileSync(resolve(root, paths.executor), 'utf8');
  assert.ok(source.includes('authorityOnly: true'));
  const result = probe(t, {
    executor: source.replace('authorityOnly: true', 'authorityOnly: false'),
  });
  assert.notEqual(result.status, 0);
});
