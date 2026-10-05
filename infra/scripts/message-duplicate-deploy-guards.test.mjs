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
  phones: 'apps/api/src/moderation/duplicate-phone-evidence.ts',
  content: 'apps/api/src/moderation/message-duplicate/message-duplicate-content.ts',
  history: 'apps/api/src/moderation/message-duplicate/message-duplicate-history.service.ts',
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
  ['state', 'text-fixed-window-safe-text-v9', 'text-fixed-window-safe-text-v8'],
  ['state', 'version: safeTextMatchingEnabled ?', 'version: false ?'],
  ['state', 'nearEnabled || phoneValueMatchingEnabled', 'nearEnabled'],
  [
    'state',
    "settings.duplicateDetectionPreset === 'CUSTOM' && settings.duplicateIgnorePhonesEnabled",
    'false',
  ],
  ['detector', '/[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*/gu', '/[a-zа-яё0-9]+/giu'],
  [
    'detector',
    'const gap = normalized.slice(end, until);',
    'const gap = normalized.slice(end, until).trim();',
  ],
  [
    'detector',
    'protectedGaps.push([beforeToken, protectedGap])',
    'protectedGaps.push([0, protectedGap])',
  ],
  ['detector', 'if (!/\\S/u.test(gap)) return;', 'if (!/[^\\p{P}\\p{Z}\\s]/u.test(gap)) return;'],
  [
    'detector',
    '/[^\\p{P}\\p{Z}\\s]/u.test(gap) ? gap : gap.replace(/\\s+/gu,',
    'false ? gap : gap.replace(/\\s+/gu,',
  ],
  [
    'detector',
    'JSON.stringify({ version: 3, tokens, numericTokens, protectedGaps })',
    'JSON.stringify({ tokens, numericTokens })',
  ],
  ['detector', 'extractDuplicatePhoneNumbers(rawText)', 'extractDetectedPhoneNumbers(rawText)'],
  ['detector', 'stripDuplicatePhoneNumbers(value)', 'stripDetectedPhoneNumbers(value)'],
  ['detector', 'stripDuplicatePhoneNumbers(source)', 'stripDetectedPhoneNumbers(source)'],
  ['detector', 'text-v7\\0', 'text-v6\\0'],
  ['detector', "value = replaceUrlsInText(value, ' ');", 'value = stripUrlsFromText(value);'],
  ['detector', "source = replaceUrlsInText(source, ' ');", 'source = stripUrlsFromText(source);'],
  ['phones', 'DUPLICATE_PHONE_EVIDENCE_VERSION = 3', 'DUPLICATE_PHONE_EVIDENCE_VERSION = 2'],
  [
    'phones',
    "import { getUrlTextRanges } from '../common/url-text.util';",
    "import { getUrlTextRanges } from '../common/unsupported-url-text.util';",
  ],
  ['phones', 'if (hasEmbeddedIdentifierAdjacency(before, after)) return null;', ''],
  ['phones', '(?:tel|mailto|sms|callto|sips?):$', '(?:unsupported):$'],
  ['phones', 'if (/@[^\\s]*$/u.test(before) || /^[^\\s]*@/u.test(after)) return true;', ''],
  ['phones', '/[=+*/\\u2212-]\\s*$/u.test(before)', 'false'],
  ['phones', '/(?:^|\\s)(?:\\p{L}\\p{M}*|\\p{N}{1,6}|_)\\s+$/u.test(before)', 'false'],
  [
    'phones',
    '(IDENTIFIER_CONTEXT.test(before) || PROTECTED_LABEL_IN_CLAUSE.test(clause))',
    'false',
  ],
  [
    'phones',
    'before.replace(/[^\\s\\p{L}\\p{M}\\p{N}_]+$/u,',
    'before.replace(/[^\\p{L}\\p{M}\\p{N}_]+$/u,',
  ],
  [
    'phones',
    'after.replace(/^[^\\s\\p{L}\\p{M}\\p{N}_]+/u,',
    'after.replace(/^[^\\p{L}\\p{M}\\p{N}_]+/u,',
  ],
  [
    'phones',
    '(label.index === 0 || /^\\s/u.test(label[0]) || /\\s$/u.test(left.slice(0, label.index)))',
    'true',
  ],
  ['phones', '/[\\p{L}\\p{M}\\p{N}_]$/u.test(left) && !labelled', 'false'],
  ['phones', '/^[\\p{L}\\p{M}\\p{N}_]/u.test(right)', 'false'],
  [
    'phones',
    'return ranges.some((range) => start < range.end && end > range.start);',
    'return ranges.some((range) => start < range.end || end > range.start);',
  ],
  ['phones', 'const urlRanges = getUrlTextRanges(text);', 'const urlRanges = [];'],
  [
    'phones',
    'if (isDuplicatePhoneCandidateInUrl(urlRanges, start, start + candidate.length)) continue;',
    '',
  ],
  [
    'phones',
    'if (isDuplicatePhoneCandidateInUrl(urlRanges, start, start + candidate.length)) return match;',
    '',
  ],
  ['phones', 'hasProtectedValueContext(before, after)', 'false'],
  [
    'phones',
    "const international = candidate.startsWith('+') && /^[1-9]\\d{9,14}$/u.test(digits);",
    'const international = true;',
  ],
  ['phones', 'if (/^[17]/u.test(digits) && digits.length !== 11) return null;', ''],
  [
    'phones',
    "if (!international && digits.startsWith('8') && digits.length !== 11) return null;",
    '',
  ],
  [
    'phones',
    "if (!international && digits.startsWith('9') && digits.length !== 10) return null;",
    '',
  ],
  ['phones', 'const labelled = PHONE_CONTEXT.test(before);', 'const labelled = true;'],
  ['phones', 'if (!international && !labelled) return null;', ''],
  [
    'phones',
    'if (!international && !labelled) return null;',
    "if (!candidate.startsWith('+') && !grouped && !labelled) return null;",
  ],
  ['phones', '\\.(?![ \\t])', '\\.'],
  ['content', 'if (!isDuplicateContentComparable(content, mode)) return null;', ''],
  [
    'content',
    "content.complete || (mode === 'TEXT' && content.reason === 'unsupported_attachment')",
    'content.complete',
  ],
  [
    'history',
    'pendingSafe: isDuplicateContentComparable(input.content, mode)',
    'pendingSafe: input.content.complete',
  ],
  ['history', 'return isDuplicateContentComparable(content, mode)', 'return content.complete'],
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

test('rejects broad phone roots even with phone evidence v3 and the v9 settings fence', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  assert.match(source, /DUPLICATE_PHONE_EVIDENCE_VERSION\s*=\s*3\b/u);
  const declaration = /const PHONE_CONTEXT\s*=\s*\/[^\r\n]+\/iu;/u;
  assert.match(source, declaration);
  const phones = source.replace(
    declaration,
    'const PHONE_CONTEXT =\n' +
      '  /(?:^|[^\\p{L}\\p{N}_])(?:тел(?:ефон)?\\p{L}*|мобильн\\p{L}*|звон\\p{L}*|whatsapp|ватсап|viber|вайбер|phone|mobile|call)\\s*(?:для\\s+связи\\s*)?[:=№#.-]?\\s*$/iu;',
  );
  assert.notEqual(phones, source);
  const result = probe(t, { phones });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

test('rejects removal of the raw arithmetic guard while identifier adjacency remains', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const guard = /if\s*\(\s*!PHONE_CONTEXT\.test\(before\) &&[\s\S]*?\)\s*return true;/u;
  assert.match(source, guard);
  const phones = source.replace(guard, '');
  assert.notEqual(phones, source);
  assert.ok(phones.includes('if (hasEmbeddedIdentifierAdjacency(before, after)) return null;'));
  assert.ok(phones.includes('const label = PHONE_CONTEXT.exec(left);'));
  const result = probe(t, { phones });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

for (const context of ['IDENTIFIER_CONTEXT', 'PROTECTED_LABEL_IN_CLAUSE']) {
  for (const [noun, forms] of [
    ['номер', 'номер(?:а|у|ом|е|ов|ам|ами|ах)?'],
    ['код', 'код(?:а|у|ом|е|ы|ов|ам|ами|ах)?'],
    ['идентификатор', 'идентификатор(?:а|у|ом|е|ы|ов|ам|ами|ах)?'],
    ['артикул', 'артикул(?:а|у|ом|е|ы|ов|ам|ами|ах)?'],
  ]) {
    test('rejects singular-only ' + noun + ' in ' + context, (t) => {
      const source = readFileSync(resolve(root, paths.phones), 'utf8');
      const declaration = new RegExp('const ' + context + '\\s*=\\s*\\/[^\\r\\n]+\\/iu;', 'u');
      const matched = source.match(declaration)?.[0];
      assert.ok(matched);
      assert.ok(matched.includes(forms));
      const updated = matched.replace(forms, noun);
      assert.notEqual(updated, matched);
      const phones = source.replace(matched, updated);
      assert.equal(
        phones.split(forms).length,
        source.split(forms).length - 1,
        'Only the selected context may lose the inflected forms',
      );
      const result = probe(t, { phones });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
      );
    });
  }
}

test('rejects raw adjacency guard moved after wrapper normalization', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const guard = '  if (hasEmbeddedIdentifierAdjacency(before, after)) return null;\n';
  const normalizationEnd = source.indexOf('\n', source.indexOf('  after = after.replace('));
  assert.ok(source.includes(guard));
  assert.ok(normalizationEnd > source.indexOf(guard));
  const phones =
    source.slice(0, normalizationEnd).replace(guard, '') +
    '\n' +
    guard.trimEnd() +
    source.slice(normalizationEnd);
  assert.notEqual(phones, source);
  assert.ok(
    phones.indexOf('if (hasEmbeddedIdentifierAdjacency(before, after)) return null;') >
      phones.indexOf('after = after.replace('),
  );
  const result = probe(t, { phones });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

for (const marker of [
  'export function extractDuplicatePhoneNumbers(',
  'export function stripDuplicatePhoneNumbers(',
]) {
  test('rejects missing URL range extraction in ' + marker, (t) => {
    const source = readFileSync(resolve(root, paths.phones), 'utf8');
    const start = source.indexOf(marker);
    const end = source.indexOf('\n}', start + 1) + 2;
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    const updated = body.replace(
      'const urlRanges = getUrlTextRanges(text);',
      'const urlRanges = [];',
    );
    assert.notEqual(updated, body);
    const phones = source.slice(0, start) + updated + source.slice(end);
    assert.ok(
      phones.includes('const urlRanges = getUrlTextRanges(text);'),
      'The other phone path must keep its URL ranges',
    );
    const result = probe(t, { phones });
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
