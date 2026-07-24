import {
  AUDIT_MESSAGE_EVENT_TYPES,
  derivePolicyCategory,
  deriveSafeContextBucket,
  deriveAuditEventFingerprint,
  formatAuditSampleLines,
  isCommercialEnforcementAction,
  publishAuditJsonlOutputs,
  readCliOptions,
  resolveAuditCandidateScope,
  resolveAuditChatSettings,
  resolveAuditDetectionSettings,
  resolveAuditLoadSince,
  resolveCorpusSanitizedBaseline,
  sanitizeAuditText,
  serializeAuditCorpusRecord,
  type AuditRecord,
} from './audit-commercial-filter';
import type { ChatSettings } from '../prisma/prisma-client';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emptySnapshot = {
  hit: false,
  score: null,
  actionScore: null,
  confidenceScore: null,
  decisionBand: null,
  primarySubtype: null,
  supportingSubtypes: [],
  evidenceStrength: null,
  classifierVersion: null,
  commercialProbability: null,
  reviewProbability: null,
  classifierReasons: [],
  reviewRecommended: false,
  reviewReasons: [],
  matchedSignals: [],
  negativeSignals: [],
  decisionVersion: null,
  fpRisk: null,
  evidenceTier: null,
  subtype: null,
  actionBand: null,
  reviewPriority: null,
  campaignStrength: null,
  safeContextBucket: null,
  actionable: false,
  recordable: false,
  deleteSuppressed: false,
  suppressionReasons: [],
  reasonCodes: [],
  featureVector: {},
};

function buildAuditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    category: 'current_only',
    policyCategory: 'hard_delete',
    segment: 'SERVICES',
    safeContextBucket: 'none',
    label: 'positive_candidate',
    labelSource: 'commercial-audit-policy-v1',
    expectedAction: 'DELETE',
    expectedSubtype: 'SERVICES',
    isHardNegative: false,
    createdAt: new Date('2026-07-23T10:11:12.000Z'),
    webhookEventId: 'webhook-secret-id',
    eventType: 'message_created',
    chatId: 'chat-secret-id',
    chatTitle: 'Secret Chat Title',
    chatEntityType: 'CHAT',
    messageId: 'message-secret-id',
    senderId: 'sender-secret-id',
    text: 'Сырой текст https://private.example/path +7 999 123-45-67',
    sanitizedText: 'Сырой текст [url] [phone]',
    historical: emptySnapshot,
    current: { ...emptySnapshot, hit: true, actionBand: 'DELETE' },
    sanitizedBaseline: { ...emptySnapshot, hit: true, actionBand: 'DELETE' },
    settings: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
    commercialCampaignContext: null,
    ...overrides,
  };
}

describe('audit-commercial-filter CLI options', () => {
  it('keeps --limit all as an unlimited audit', () => {
    expect(readCliOptions(['--limit', 'all']).limit).toBeNull();
    expect(readCliOptions(['--limit=all']).limit).toBeNull();
    expect(readCliOptions(['--limit=ALL']).limit).toBeNull();
  });

  it('uses the default limit only when --limit is omitted', () => {
    expect(readCliOptions([]).limit).toBe(1500);
  });

  it('rejects non-integer limit values instead of truncating them', () => {
    expect(() => readCliOptions(['--limit', '10x'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
    expect(() => readCliOptions(['--limit', '1e6'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
    expect(() => readCliOptions(['--limit', '0'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
  });

  it('keeps missing option values explicit', () => {
    expect(() => readCliOptions(['--limit'])).toThrow('--limit requires a value');
    expect(() => readCliOptions(['--sample'])).toThrow('--sample requires a value');
  });

  it('rejects audit and corpus outputs that resolve to the same path', () => {
    expect(() =>
      readCliOptions([
        '--export-jsonl',
        'artifacts/commercial-audit/output.jsonl',
        '--export-corpus-jsonl',
        'artifacts/commercial-audit/./output.jsonl',
      ]),
    ).toThrow('--export-jsonl and --export-corpus-jsonl must resolve to different paths');
  });

  it('allows --sample 0 for aggregate-only audits', () => {
    expect(readCliOptions(['--sample', '0']).sample).toBe(0);
  });

  it('keeps the default audit scoped to chats where the filter is enabled', () => {
    expect(readCliOptions([]).shadowAllChats).toBe(false);
  });

  it('can run a shadow commercial pass across all chats', () => {
    expect(readCliOptions(['--shadow-all-chats']).shadowAllChats).toBe(true);
  });

  it('supports a bounded campaign warm-up only for unlimited chronological audits', () => {
    const options = readCliOptions([
      '--since',
      '2026-07-21T11:20:41.000Z',
      '--limit',
      'all',
      '--campaign-warmup-hours',
      '36',
      '--current-only',
    ]);

    expect(options.campaignWarmupHours).toBe(36);
    expect(options.currentOnly).toBe(true);
    expect(resolveAuditLoadSince(options).toISOString()).toBe('2026-07-19T23:20:41.000Z');
  });

  it('rejects campaign warm-up when a newest-row limit would discard the pre-roll', () => {
    expect(() => readCliOptions(['--campaign-warmup-hours', '36'])).toThrow(
      '--campaign-warmup-hours requires --limit all',
    );
    expect(() => readCliOptions(['--limit', 'all', '--campaign-warmup-hours', '169'])).toThrow(
      '--campaign-warmup-hours must be less than or equal to 168',
    );
  });

  it('rejects non-integer sample values instead of truncating them', () => {
    expect(() => readCliOptions(['--sample', '2x'])).toThrow(
      '--sample must be a non-negative integer',
    );
    expect(() => readCliOptions(['--sample', '1e6'])).toThrow(
      '--sample must be a non-negative integer',
    );
  });
});

describe('commercial enforcement action semantics', () => {
  it('counts WARN because moderation deletes the message before sending its warning', () => {
    expect(isCommercialEnforcementAction('WARN')).toBe(true);
    expect(isCommercialEnforcementAction('DELETE')).toBe(true);
    expect(isCommercialEnforcementAction('DELETE_AND_ESCALATE')).toBe(true);
    expect(isCommercialEnforcementAction('REVIEW_ONLY')).toBe(false);
    expect(isCommercialEnforcementAction('ALLOW')).toBe(false);
    expect(isCommercialEnforcementAction(null)).toBe(false);
  });
});

describe('audit-commercial-filter scope helpers', () => {
  it('audits created and edited message events because moderation handles both', () => {
    expect(AUDIT_MESSAGE_EVENT_TYPES).toEqual(['message_created', 'message_edited']);
  });

  it('keeps the default candidate scope on chats where the filter is enabled', () => {
    expect(resolveAuditCandidateScope({ shadowAllChats: false })).toEqual({
      logLabel: 'enabled-chats',
      settingsJoin: 'inner',
      requireCommercialAdsFilterEnabled: true,
    });
  });

  it('uses a left settings join for all-chat shadow audits', () => {
    expect(resolveAuditCandidateScope({ shadowAllChats: true })).toEqual({
      logLabel: 'shadow-all-chats',
      settingsJoin: 'left',
      requireCommercialAdsFilterEnabled: false,
    });
  });

  it('uses default commercial settings when a shadow-audited chat has no settings row', () => {
    const settings = resolveAuditChatSettings(null);

    expect(settings.commercialAdsFilterEnabled).toBe(false);
    expect(settings.commercialAdsSensitivity).toBe('BALANCED');
    expect(settings.commercialAdsWarnThreshold).toBe(45);
    expect(settings.commercialAdsDeleteThreshold).toBe(65);
  });

  it('enables commercial detection only inside the shadow audit pass', () => {
    const settings = {
      commercialAdsFilterEnabled: false,
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    } as ChatSettings;

    expect(
      resolveAuditDetectionSettings(settings, { shadowAllChats: false }).commercialAdsFilterEnabled,
    ).toBe(false);
    expect(
      resolveAuditDetectionSettings(settings, { shadowAllChats: true }).commercialAdsFilterEnabled,
    ).toBe(true);
  });
});

describe('deriveSafeContextBucket', () => {
  it('does not classify commercial ads as moderation context just because they mention admins or bots', () => {
    for (const text of [
      'АДМИНИСТРАТОР на ресепшен, 74400 руб., смены, опыт приветствуется, писать в тг',
      'В нашей группе можно купить и продать все, что не запрещено законом РФ',
      'Предлагаем публикацию вашей рекламы в чате, где нет ботов, за подробностями в личные сообщения',
    ]) {
      expect(
        deriveSafeContextBucket({
          text,
          current: emptySnapshot,
          historical: emptySnapshot,
        }),
      ).not.toBe('rules_or_moderation_context');
    }
  });

  it('keeps actual ad-moderation discussions in the rules bucket', () => {
    expect(
      deriveSafeContextBucket({
        text: 'По правилам чата реклама и ссылки запрещены, бот удалит такие объявления.',
        current: emptySnapshot,
        historical: emptySnapshot,
      }),
    ).toBe('rules_or_moderation_context');
  });

  it('does not let text-only rules wording override an existing commercial hit', () => {
    expect(
      deriveSafeContextBucket({
        text: 'Объявления Казань. Тут только ссылки на группы, другие удаляем. Присоединяйся к чату.',
        current: {
          ...emptySnapshot,
          hit: true,
          actionBand: 'REVIEW_ONLY',
          primarySubtype: 'CHANNEL_PLACEMENT',
        },
        historical: emptySnapshot,
      }),
    ).not.toBe('rules_or_moderation_context');
  });
});

describe('derivePolicyCategory', () => {
  it('keeps high-fp review-only detections in the gray zone instead of negative corpus labels', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          confidenceScore: 41,
          decisionBand: 'MEDIUM',
          actionBand: 'REVIEW_ONLY',
          fpRisk: 82,
          reviewRecommended: true,
        },
      }),
    ).toBe('gray_zone');
  });

  it('still flags high-fp hard deletes as false-positive candidates', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          confidenceScore: 80,
          decisionBand: 'HIGH',
          actionBand: 'DELETE',
          fpRisk: 82,
        },
      }),
    ).toBe('false_positive_candidate');
  });

  it('does not mark campaign-assisted direct deal detections as campaign-only', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          actionBand: 'DELETE',
          evidenceStrength: 'CAMPAIGN',
          matchedSignals: [
            'transaction:implied-price',
            'contact:contextual-phone',
            'campaign:cross-chat-text',
          ],
        },
      }),
    ).toBe('hard_delete');
  });
});

describe('sanitizeAuditText', () => {
  it('masks local 10-digit phone numbers in exported audit text', () => {
    expect(sanitizeAuditText('Звонить 9132349385, цена 750 тр.')).toBe(
      'Звонить [phone], цена 750 тр.',
    );
  });

  it('masks payment-card numbers in exported audit text', () => {
    expect(sanitizeAuditText('Перевод на карту 2202 2002 0000 0001, получатель Иван.')).toBe(
      'Перевод на карту [card], получатель Иван.',
    );
    expect(sanitizeAuditText('Карта: 2202200200000001')).toBe('Карта: [card]');
    expect(sanitizeAuditText('PAN 1234567890123')).toBe('PAN [card]');
    expect(sanitizeAuditText('Счёт 12345678901234567890')).toBe('Счёт [account]');
  });
});

describe('audit export privacy', () => {
  it('prints only sanitized text and pseudonymous event metadata in samples', () => {
    const record = buildAuditRecord();
    const output = formatAuditSampleLines(record).join('\n');

    expect(output).toContain(`eventFingerprint=${deriveAuditEventFingerprint(record)}`);
    expect(output).toContain('text=Сырой текст [url] [phone]');
    for (const sensitiveValue of [
      record.chatTitle,
      record.chatId,
      record.messageId,
      record.senderId,
      'https://private.example/path',
      '+7 999 123-45-67',
    ]) {
      expect(output).not.toContain(sensitiveValue);
    }
    expect(output).not.toContain('chatId=');
    expect(output).not.toContain('messageId=');
    expect(output).not.toContain('senderId=');
  });

  it('adds time and a stable fingerprint to corpus records without raw identifiers', () => {
    const record = buildAuditRecord();
    const serialized = serializeAuditCorpusRecord(record);
    const payload = JSON.stringify(serialized);

    expect(serialized).toMatchObject({
      createdAt: '2026-07-23T10:11:12.000Z',
      eventFingerprint: deriveAuditEventFingerprint(record),
      eventType: 'message_created',
      text: 'Сырой текст [url] [phone]',
      sanitizedBaseline: record.sanitizedBaseline,
    });
    expect(serialized.eventFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    for (const rawKey of ['webhookEventId', 'chatId', 'chatTitle', 'messageId', 'senderId']) {
      expect(serialized).not.toHaveProperty(rawKey);
    }
    for (const sensitiveValue of [
      record.webhookEventId,
      record.chatId,
      record.chatTitle,
      record.messageId,
      record.senderId,
    ]) {
      expect(payload).not.toContain(sensitiveValue);
    }
  });

  it('rejects a corpus record whose sanitized baseline was not computed', () => {
    expect(() =>
      serializeAuditCorpusRecord(buildAuditRecord({ sanitizedBaseline: undefined })),
    ).toThrow('Corpus export record is missing its sanitized baseline');
  });
});

describe('corpus sanitized baseline scheduling', () => {
  it('does not run the sanitized detector without a requested retained corpus record', async () => {
    const detectSanitized = jest.fn(async () => emptySnapshot);
    const current = { ...emptySnapshot, hit: true };

    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: false,
        retainedForCorpus: true,
        rawText: 'raw +7 999 123-45-67',
        sanitizedText: 'raw [phone]',
        current,
        detectSanitized,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: true,
        retainedForCorpus: false,
        rawText: 'raw +7 999 123-45-67',
        sanitizedText: 'raw [phone]',
        current,
        detectSanitized,
      }),
    ).resolves.toBeUndefined();
    expect(detectSanitized).not.toHaveBeenCalled();
  });

  it('reuses an unchanged snapshot and detects only changed sanitized text', async () => {
    const sanitizedSnapshot = { ...emptySnapshot, hit: false };
    const detectSanitized = jest.fn(async () => sanitizedSnapshot);
    const current = { ...emptySnapshot, hit: true };

    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: true,
        retainedForCorpus: true,
        rawText: 'unchanged',
        sanitizedText: 'unchanged',
        current,
        detectSanitized,
      }),
    ).resolves.toBe(current);
    expect(detectSanitized).not.toHaveBeenCalled();

    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: true,
        retainedForCorpus: true,
        rawText: 'raw +7 999 123-45-67',
        sanitizedText: 'raw [phone]',
        current,
        detectSanitized,
      }),
    ).resolves.toBe(sanitizedSnapshot);
    expect(detectSanitized).toHaveBeenCalledTimes(1);
  });
});

describe('audit JSONL publication', () => {
  it('publishes complete sibling-staged files as mode 0600 and never overwrites them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-export-'));
    const outputPath = join(directory, 'nested', 'audit.jsonl');

    try {
      await publishAuditJsonlOutputs([{ pathname: outputPath, payload: '{"run":1}\n' }]);

      expect(await readFile(outputPath, 'utf8')).toBe('{"run":1}\n');
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(directory, 'nested'))).toEqual(['audit.jsonl']);

      await expect(
        publishAuditJsonlOutputs([{ pathname: outputPath, payload: '{"run":2}\n' }]),
      ).rejects.toThrow('Refusing to overwrite existing audit export');
      expect(await readFile(outputPath, 'utf8')).toBe('{"run":1}\n');
      expect(await readdir(join(directory, 'nested'))).toEqual(['audit.jsonl']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back the first output when no-clobber publication of the second fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-export-pair-'));
    const auditPath = join(directory, 'audit.jsonl');
    const corpusPath = join(directory, 'corpus.jsonl');

    try {
      await writeFile(corpusPath, 'existing corpus\n', { mode: 0o600 });

      await expect(
        publishAuditJsonlOutputs([
          { pathname: auditPath, payload: 'new audit\n' },
          { pathname: corpusPath, payload: 'new corpus\n' },
        ]),
      ).rejects.toThrow('Refusing to overwrite existing audit export');
      await expect(access(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(corpusPath, 'utf8')).toBe('existing corpus\n');
      expect((await readdir(directory)).sort()).toEqual(['corpus.jsonl']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
