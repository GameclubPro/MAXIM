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
  window: 'apps/api/src/moderation/message-duplicate/message-duplicate-window.script.ts',
  settings: 'packages/contracts/src/duplicate-settings.ts',
  semantic: 'apps/api/src/moderation/duplicate-semantic-text.ts',
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
  ['state', 'text-fixed-window-safe-text-v12', 'text-fixed-window-safe-text-v11'],
  ['state', 'text-fixed-window-v12', 'text-fixed-window-v5'],
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
  ['detector', 'analyzeDuplicatePhoneNumbers(rawText)', 'analyzeDetectedPhoneNumbers(rawText)'],
  ['detector', 'stripAnalyzedDuplicatePhoneNumbers(rawText, phoneAnalysis, config)', 'rawText'],
  [
    'detector',
    'const numericTokens = approximateSource.match(',
    'const numericTokens = normalized.match(',
  ],
  ['detector', 'text-v12\\0', 'text-v9\\0'],
  ['phones', 'DUPLICATE_PHONE_EVIDENCE_VERSION = 6', 'DUPLICATE_PHONE_EVIDENCE_VERSION = 5'],
  ['detector', 'return normalizeDuplicateSemanticText(value);', 'return value.toLowerCase();'],
  ['content', 'return normalizeDuplicateSemanticText(value);', 'return value.toLowerCase();'],
  [
    'semantic',
    'protectedQuantityUnit(source.slice(from, end))',
    'source.slice(from, end).toLowerCase()',
  ],
  ['phones', 'hasDuplicateQuantityUnitSuffix(after)', 'false'],
  ['phones', 'hasDuplicateQuantityUnitSuffix(value)', 'false'],
  ['semantic', 'const QUANTITY_UNITS = new Set(', 'const QUANTITY_UNITS = new Map('],
  [
    'semantic',
    'wordUnit[1]! + wordUnit[2]!.toLowerCase() : unit',
    'wordUnit[1]!.toLowerCase() + wordUnit[2]!.toLowerCase() : unit.toLowerCase()',
  ],
  ['semantic', "unit.replace(/\\p{Cf}/gu, '').toLowerCase()", 'unit.toLowerCase()'],
  ['semantic', 'return unit !== undefined && isQuantityUnit(unit);', 'return unit !== undefined;'],
  ['semantic', 'if (!isQuantityUnit(unit)) continue;', 'if (false) continue;'],
  ['semantic', 'if (!next || !isQuantityUnit(next[1]!)) break;', 'if (!next) break;'],
  [
    'semantic',
    'quantities.lastIndex = end;',
    'quantities.lastIndex = quantity.index + quantity[0].length;',
  ],
  [
    'phones',
    "import { getUrlTextRanges } from '../common/url-text.util';",
    "import { getUrlTextRanges } from '../common/unsupported-url-text.util';",
  ],
  ['phones', 'if (hasEmbeddedIdentifierAdjacency(before, after, afterTruncated)) return null;', ''],
  ['phones', '(?:tel|mailto|sms|callto|sips?):$', '(?:unsupported):$'],
  ['phones', 'if (/@[^\\s]*$/u.test(before) || /^[^\\s]*@/u.test(after)) return true;', ''],
  [
    'phones',
    "const arithmeticContext = before.replace(/\\p{Cf}/gu, '');",
    'const arithmeticContext = before;',
  ],
  [
    'phones',
    'const arithmeticBefore = arithmeticContext.replace(',
    'const arithmeticBefore = before.replace(',
  ],
  ['phones', '/[\\p{Sm}*/%^·\\u2010-\\u2013-]$/u.test(arithmeticBefore)', 'false'],
  [
    'phones',
    '/[\\p{Sm}*/%^·\\u2010-\\u2013-]$/u.test(arithmeticBefore)',
    '/[=+*/\\u2212-]$/u.test(arithmeticBefore)',
  ],
  ['phones', '/(?:^|\\s)(?:\\p{L}\\p{M}*|\\p{N}{1,6}|_)\\s+$/u.test(arithmeticContext)', 'false'],
  [
    'phones',
    '/(?:^|\\s)(?:\\p{L}\\p{M}*|\\p{N}{1,6}|_)\\s+$/u.test(arithmeticContext)',
    '/(?:^|\\s)(?:\\p{L}\\p{M}*|\\p{N}{1,6}|_)\\s+$/u.test(before)',
  ],
  ['phones', 'if (/\\p{Sc}$/u.test(arithmeticBefore)) return true;', ''],
  [
    'phones',
    '[\\s\\p{Cf})\\]}»"\'”’]*[\\p{Sm}*/%^·\\u2010-\\u2013-]+[\\s\\p{Cf}]*',
    '[\\s)\\]}»"\'”’]*[\\p{Sm}*/%^·\\u2010-\\u2013-]+\\s*',
  ],
  ['phones', '[\\p{Sm}*/%^·\\u2010-\\u2013-]', '[\\p{Sm}*/%^-]'],
  ['phones', '!hasLabelledPhoneListContinuation(arithmeticBefore, after, afterTruncated)', 'false'],
  ['phones', '!hasLabelledPhoneListPredecessor(arithmeticContext)', 'false'],
  ['phones', '/(?:^|\\s)[+-]?\\d(?:[\\d \\t().-]*\\d)?\\s+$/u.test(arithmeticContext)', 'false'],
  ['phones', 'if (!PHONE_CONTEXT.test(before)) return false;', ''],
  [
    'phones',
    'const next = after.matchAll(CANDIDATE).next().value;',
    'const next = before.matchAll(CANDIDATE).next().value;',
  ],
  ['phones', 'after.slice(0, start)', 'after.slice(start, start)'],
  [
    'phones',
    "phoneEvidence(candidate, '', after.slice(start + candidate.length), afterTruncated) !== null",
    "phoneEvidence(candidate, 'телефон:', after.slice(start + candidate.length), afterTruncated) !== null",
  ],
  [
    'phones',
    "phoneEvidence(candidate, '', after.slice(start + candidate.length), afterTruncated) !== null",
    'true',
  ],
  ['phones', 'const prefix = before.slice(0, start);', "const prefix = 'телефон:';"],
  ['phones', '/^\\s*$/u.test(before.slice(start + candidate.length))', 'true'],
  ['phones', "phoneEvidence(candidate, prefix, '') !== null", 'true'],
  ['phones', "before = before.replace(/\\p{Cf}/gu, '').replace(", 'before = before.replace('],
  ['phones', "after = after.replace(/\\p{Cf}/gu, '').replace(", 'after = after.replace('],
  [
    'phones',
    'const phoneNumberLabel = PHONE_NUMBER_CONTEXT.test(before);',
    'const phoneNumberLabel = PHONE_CONTEXT.test(before);',
  ],
  [
    'phones',
    "const protectedClause = clause.replace(PHONE_NUMBER_CONTEXT, ' ');",
    'const protectedClause = clause;',
  ],
  ['phones', 'QUANTITY_PREFIX.test(before) ||', 'false ||'],
  ['phones', 'QUANTITY_SUFFIX.test(after) ||', 'false ||'],
  ['phones', '(IDENTIFIER_CONTEXT.test(before) && !phoneNumberLabel)', 'false'],
  [
    'phones',
    '(IDENTIFIER_CONTEXT.test(before) && !phoneNumberLabel)',
    '(!PHONE_CONTEXT.test(before) && IDENTIFIER_CONTEXT.test(before))',
  ],
  ['phones', 'PROTECTED_LABEL_IN_CLAUSE.test(protectedClause)', 'false'],
  [
    'phones',
    'PROTECTED_LABEL_IN_CLAUSE.test(protectedClause)',
    '(!PHONE_CONTEXT.test(before) && PROTECTED_LABEL_IN_CLAUSE.test(protectedClause))',
  ],
  ['phones', 'тыс\\.?', 'тыс'],
  ['phones', 'участник\\p{L}*', 'unsupportedParticipants'],
  ['phones', '[kmgt]i?(?:b|bps|bits?)', '[kmgt]i?b'],
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
  ['phones', 'const urlRanges = getUrlTextRanges(text);', 'const urlRanges = [];'],
  ['phones', 'if (urlIndex < urlRanges.length && urlRanges[urlIndex]!.start < end) continue;', ''],
  [
    'phones',
    'while (urlIndex < urlRanges.length && urlRanges[urlIndex]!.end <= start) urlIndex += 1;',
    '',
  ],
  ['phones', 'if (beforeStart > 0 && !CONTEXT_CLAUSE_BOUNDARY.test(before)) continue;', ''],
  ['phones', 'end + 64 < text.length', 'false'],
  ['phones', 'if (afterTruncated && UNFINISHED_RIGHT_CONTEXT.test(after)) return null;', ''],
  ['phones', 'QUANTITY_SUFFIX.test(value) ||', 'false ||'],
  ['phones', '(afterTruncated && !/[\\s.!?;,\\n\\r\\u2028\\u2029]/u.test(value))', 'false'],
  ['phones', 'options.ignorePhones ? analysis.phoneRanges : []', 'analysis.phoneRanges'],
  ['phones', 'options.ignoreLinks ? analysis.urlRanges : []', 'analysis.urlRanges'],
  [
    'window',
    "MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION = 'v3'",
    "MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION = 'v2'",
  ],
  ['window', 'local resetPrefix = prefix', 'local resetPrefix = KEYS[1]'],
  ['window', 'math.min(at and at > 0 and at or now, now) + retentionMs', 'now + retentionMs'],
  ['window', "'PXAT', expiry", "'EX', 1209661"],
  ['window', "redis.call('PEXPIRETIME', prefix .. key)", '-1'],
  ['window', 'if previousExpiry > now then expiry = math.min(expiry, previousExpiry) end', ''],
  [
    'window',
    'write(stateKey(p.member), state, windowExpiry(state.at), true)',
    'write(stateKey(p.member), state)',
  ],
  ['window', 'math.min((p.windowMs or 0) + graceMs, retentionMs)', 'retentionMs'],
  ['window', 'materialized = previous and previous.materialized or nil', 'materialized = nil'],
  [
    'window',
    'life.materialized = { epoch = currentEpoch, at = p.at, source = p.source, identity = p.identity }',
    "life.materialized = { epoch = currentEpoch, at = p.at, source = p.source, identity = 'old' }",
  ],
  ['window', 'materialized.epoch ~= currentEpoch', 'false'],
  ['window', 'p.at <= materialized.at', 'false'],
  ['window', "materialized.identity == '' or p.identity == materialized.identity", 'false'],
  ['window', 'previousLife.materializedRevision and currentEpoch ~= 0', 'false'],
  ['window', 'life.introducedAt <= currentEpoch', 'false'],
  [
    'window',
    'if previous and previous.epoch == currentEpoch and previous.source ~= p.source',
    'if previous and previous.source ~= p.source',
  ],
  [
    'window',
    'elseif previous and previous.epoch == currentEpoch and previous.revision == life.revision',
    'elseif previous and previous.revision == life.revision',
  ],
  [
    'window',
    'p.windowMs = math.min(p.windowMs, ${DUPLICATE_WINDOW_MAX_SEC * 1000})',
    'p.windowMs = p.windowMs',
  ],
  ['settings', 'DUPLICATE_WINDOW_MAX_SEC = 48 * 3_600', 'DUPLICATE_WINDOW_MAX_SEC = 168 * 3_600'],
  ['settings', 'return Math.min(DUPLICATE_WINDOW_MAX_SEC, configured)', 'return configured'],
  [
    'state',
    'historyStorageVersion: MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION',
    "historyStorageVersion: 'v2'",
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
  ['phones', 'const knownLength =', 'const knownLength = true ||'],
  ['phones', 'if (!international && !knownLength) return null;', ''],
  [
    'phones',
    'if (!international && !knownLength) return null;',
    'if (false && !knownLength) return null;',
  ],
  ['phones', 'if (!knownLength && /[^\\d+]/u.test(candidate)) return null;', ''],
  [
    'phones',
    'if (!knownLength && /[^\\d+]/u.test(candidate)) return null;',
    'if (false && /[^\\d+]/u.test(candidate)) return null;',
  ],
  ['phones', "if (candidate.includes('.')) {", 'if (false) {'],
  ['phones', '?.map((group) => group.length)', '?.map(() => 1)'],
  ['phones', "['1/3/3/2/2', '1/3/3/4'].includes(groups ?? '')", 'true'],
  ['phones', "groups === '3/3/2/2'", 'true'],
  ['phones', 'if (!knownLength || !conventionalGroups) return null;', ''],
  ['phones', 'const labelled = PHONE_CONTEXT.test(before);', 'const labelled = true;'],
  ['phones', 'if (!international && !labelled) return null;', ''],
  [
    'phones',
    'if (!international && !labelled) return null;',
    "if (!candidate.startsWith('+') && !grouped && !labelled) return null;",
  ],
  ['phones', '\\.(?![ \\t\\u00a0\\u202f])', '\\.'],
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

test('rejects broad phone roots even with phone evidence v6 and the v12 settings fences', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  assert.match(source, /DUPLICATE_PHONE_EVIDENCE_VERSION\s*=\s*6\b/u);
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

test('rejects an identifier label expanded into the finite phone-number exception', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const declaration = /const PHONE_NUMBER_CONTEXT\s*=\s*\/[^\r\n]+\/iu;/u;
  const matched = source.match(declaration)?.[0];
  assert.ok(matched);
  const updated = matched.replace('номер(?:а|у|ом|е|ов|ам|ами|ах)?', '(?:номер|артикул|код)');
  assert.notEqual(updated, matched);
  const result = probe(t, { phones: source.replace(matched, updated) });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

test('rejects removal of the right arithmetic guard while its marker survives outside the body', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const guard =
    / {2}if \(\s*\/\^\[[^\r\n]+\/u\.test\(after\) &&\s*!hasLabelledPhoneListContinuation\(arithmeticBefore, after, afterTruncated\)\s*\)\s*return true;\n/u;
  const matched = source.match(guard)?.[0];
  assert.ok(matched);
  const phones =
    source.replace(matched, '') + '\n/* Removed capability: ' + matched.trim() + ' */\n';
  assert.ok(phones.includes(matched.trim()));
  const result = probe(t, { phones });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

test('rejects phone analysis changed to a preprocessed source', (t) => {
  const source = readFileSync(resolve(root, paths.detector), 'utf8');
  const detector = source.replace(
    'analyzeDuplicatePhoneNumbers(rawText)',
    'analyzeDuplicatePhoneNumbers(normalizeDuplicateText(rawText))',
  );
  assert.notEqual(detector, source);
  const result = probe(t, { detector });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

test('rejects removal of the raw arithmetic guard while identifier adjacency remains', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const guard = /if\s*\(\s*!PHONE_CONTEXT\.test\(arithmeticBefore\) &&[\s\S]*?\)\s*return true;/u;
  assert.match(source, guard);
  const phones = source.replace(guard, '');
  assert.notEqual(phones, source);
  assert.ok(
    phones.includes(
      'if (hasEmbeddedIdentifierAdjacency(before, after, afterTruncated)) return null;',
    ),
  );
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
    ['модель', 'модел(?:ь|и|ью|ей|ям|ями|ях)'],
    ['сертификат', 'сертификат(?:а|у|ом|е|ы|ов|ам|ами|ах)?'],
    ['штрихкод', 'штрих[- ]?код(?:а|у|ом|е|ы|ов|ам|ами|ах)?'],
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
  for (const technicalLabel of ['model', 'certificate', 'barcode', 'imei', 'ean', 'gtin']) {
    test('rejects missing ' + technicalLabel + ' in ' + context, (t) => {
      const source = readFileSync(resolve(root, paths.phones), 'utf8');
      const declaration = new RegExp('const ' + context + '\\s*=\\s*\\/[^\\r\\n]+\\/iu;', 'u');
      const matched = source.match(declaration)?.[0];
      assert.ok(matched);
      const anchor = '|' + technicalLabel + '|';
      assert.ok(matched.includes(anchor));
      const updated = matched.replace(anchor, '|');
      const phones = source.replace(matched, updated);
      const result = probe(t, { phones });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
      );
    });
  }
}

test('rejects the unprefixed confidence gate moved after label admission', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const gate = '  if (!international && !knownLength) return null;\n';
  const label = '  const labelled = PHONE_CONTEXT.test(before);\n';
  assert.ok(source.includes(gate));
  assert.ok(source.includes(label));
  assert.ok(source.indexOf(gate) < source.indexOf(label));
  const phones = source.replace(gate, '').replace(label, label + gate);
  assert.ok(phones.indexOf(gate) > phones.indexOf(label));
  const result = probe(t, { phones });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

test('rejects raw adjacency guard moved after wrapper normalization', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const guard =
    '  if (hasEmbeddedIdentifierAdjacency(before, after, afterTruncated)) return null;\n';
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
    phones.indexOf(
      'if (hasEmbeddedIdentifierAdjacency(before, after, afterTruncated)) return null;',
    ) > phones.indexOf('after = after.replace('),
  );
  const result = probe(t, { phones });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

test('rejects URL parsing removed from the shared analysis while its marker survives outside', (t) => {
  const source = readFileSync(resolve(root, paths.phones), 'utf8');
  const start = source.indexOf('export function analyzeDuplicatePhoneNumbers(');
  const end = source.indexOf('\n}', start + 1) + 2;
  const body = source.slice(start, end);
  const updated = body.replace(
    'const urlRanges = getUrlTextRanges(text);',
    'const urlRanges = [];',
  );
  assert.notEqual(updated, body);
  const phones =
    source.slice(0, start) +
    updated +
    source.slice(end) +
    '\n// const urlRanges = getUrlTextRanges(text);\n';
  const result = probe(t, { phones });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /lacks the message duplicate v3 lifecycle\/revocation\/pre-dispatch/u,
  );
});

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
    /if \(this\.messageDuplicateDeleteGuard && (?:intent\.messageDuplicateOwned|textProof\.messageDuplicateVerified)\) \{[\s\S]*?\n {12}\}/u,
    '',
  );
  assert.notEqual(updated, mutation);
  const executor = source.slice(0, start) + updated + source.slice(end);
  assert.ok(
    /this\.messageDuplicateDeleteGuard!?\.assertIntentStillActionable\(/u.test(executor),
    'The earlier full duplicate guard must survive this mutation',
  );
  const result = probe(t, { executor });
  assert.notEqual(result.status, 0);
});

for (const [name, method, before, after] of [
  [
    'qualification result',
    'private async authorizeGuardedUserDeleteReasons(',
    /\)\) === 'allowed';/u,
    ")) === 'denied';",
  ],
  [
    'returned qualification',
    'private async authorizeGuardedUserDeleteReasons(',
    /messageDuplicateVerified,/u,
    'messageDuplicateVerified: false,',
  ],
  [
    'forwarded qualification',
    'private async runDeletePreDispatchGuards(',
    /messageDuplicateVerified = proof\.messageDuplicateVerified;/u,
    'messageDuplicateVerified = false;',
  ],
  [
    'returned forwarded qualification',
    'private async runDeletePreDispatchGuards(',
    /messageDuplicateVerified,/u,
    'messageDuplicateVerified: false,',
  ],
]) {
  test('rejects a disconnected delegated duplicate ' + name, (t) => {
    const source = readFileSync(resolve(root, paths.executor), 'utf8');
    const start = source.indexOf(method);
    const end = source.indexOf('\n  private ', start + 1);
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    const updated = body.replace(before, after);
    assert.notEqual(updated, body);
    const executor = source.slice(0, start) + updated + source.slice(end);
    assert.ok(
      executor.includes('this.messageDuplicateDeleteGuard!.assertIntentStillActionable(params)'),
    );
    assert.ok(
      executor.includes(
        'if (this.messageDuplicateDeleteGuard && textProof.messageDuplicateVerified)',
      ),
    );
    assert.ok(executor.includes('authorityOnly: true'));
    const result = probe(t, { executor });
    assert.notEqual(result.status, 0);
  });
}

test('rejects a last duplicate fence that still uses remote content guards', (t) => {
  const source = readFileSync(resolve(root, paths.executor), 'utf8');
  assert.ok(source.includes('authorityOnly: true'));
  const result = probe(t, {
    executor: source.replace('authorityOnly: true', 'authorityOnly: false'),
  });
  assert.notEqual(result.status, 0);
});
