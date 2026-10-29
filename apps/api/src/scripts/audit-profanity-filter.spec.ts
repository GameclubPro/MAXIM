import {
  buildProfanityAuditReport,
  dedupeProfanityAuditEvents,
  readProfanityAuditCliOptions,
  sanitizeProfanityAuditText,
  type ProfanityAuditEvent,
} from './audit-profanity-filter';

function event(overrides: Partial<ProfanityAuditEvent> = {}): ProfanityAuditEvent {
  return {
    id: 'event-1',
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: 'message-1',
    ruleCode: 'PROFANITY',
    action: 'NONE',
    maskedExcerpt: 'ты скотина, пиши user@example.com или @handle',
    score: 0.75,
    metadata: {
      category: 'MILD_INSULT',
      detectorVersion: 'profanity-v2',
      sensitivity: 'STRICT',
      rolloutMode: 'on',
      familyId: 'exact:скотин',
      matchKind: 'EXACT_VARIANT',
      matchedVariant: 'скотина',
      evidence: ['TARGET_CONTEXT'],
    },
    createdAt: new Date('2026-08-24T10:00:00.000Z'),
    ...overrides,
  };
}

describe('profanity audit CLI', () => {
  it('uses a bounded seven-day window by default', () => {
    const now = new Date('2026-08-24T12:00:00.000Z');

    expect(readProfanityAuditCliOptions([], now)).toEqual({
      since: new Date('2026-08-17T12:00:00.000Z'),
      until: now,
      limit: 1_500,
      sample: 20,
      json: false,
      includeSanitizedText: false,
    });
  });

  it('rejects unbounded or reversed options', () => {
    expect(() => readProfanityAuditCliOptions(['--limit', '5001'])).toThrow(
      '--limit must be an integer between 1 and 5000',
    );
    expect(() =>
      readProfanityAuditCliOptions([
        '--since',
        '2026-08-24T12:00:00.000Z',
        '--until',
        '2026-08-24T11:00:00.000Z',
      ]),
    ).toThrow('--since must be earlier than or equal to --until');
  });
});

describe('profanity audit report', () => {
  it('deduplicates delete and decision events while keeping structured metadata', () => {
    const decisions = dedupeProfanityAuditEvents([
      event({
        id: 'delete-1',
        ruleCode: 'PROFANITY_DELETE',
        action: 'DELETE_MESSAGE',
        metadata: { ...(event().metadata as object), moderationDeleteVerified: true },
        createdAt: new Date('2026-08-24T10:00:00.000Z'),
      }),
      event({
        id: 'decision-1',
        metadata: null,
        score: 0.95,
        createdAt: new Date('2026-08-24T10:00:01.000Z'),
      }),
      event({
        id: 'stop-word-1',
        messageId: 'message-2',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        score: 0.89,
        metadata: { blockedWord: 'валенок', matchKind: 'pattern' },
      }),
    ]);

    expect(decisions).toHaveLength(2);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'BUILT_IN',
          category: 'MILD_INSULT',
          detectorVersion: 'profanity-v2',
          familyId: 'exact:скотин',
          deleted: true,
          sanctionAction: 'NONE',
        }),
        expect.objectContaining({
          source: 'CHAT_STOP_LIST',
          category: 'CHAT_STOP_LIST',
          matchKind: 'pattern',
        }),
      ]),
    );
  });

  it('keeps text out by default and pseudonymizes sample identifiers', () => {
    const options = readProfanityAuditCliOptions([
      '--since',
      '2026-08-23T00:00:00.000Z',
      '--until',
      '2026-08-25T00:00:00.000Z',
    ]);
    const report = buildProfanityAuditReport({
      events: [event()],
      options,
      generatedAt: new Date('2026-08-24T12:00:00.000Z'),
      pseudonymSalt: 'fixed-test-salt',
    });

    expect(report.samples[0]).toEqual(
      expect.objectContaining({
        key: expect.stringMatching(/^[a-f0-9]{16}$/u),
        source: 'BUILT_IN',
        category: 'MILD_INSULT',
      }),
    );
    expect(report.samples[0]).not.toHaveProperty('sanitizedText');
    expect(report.samples[0]).not.toHaveProperty('matchedVariant');
    expect(report.truncated).toBe(false);
    expect(report.missingStructuredMetadata).toBe(0);
    expect(JSON.stringify(report)).not.toContain('chat-1');
    expect(JSON.stringify(report)).not.toContain('user-1');
  });

  it('sanitizes contact data only after explicit text opt-in', () => {
    const options = readProfanityAuditCliOptions([
      '--since',
      '2026-08-23T00:00:00.000Z',
      '--until',
      '2026-08-25T00:00:00.000Z',
      '--include-sanitized-text',
    ]);
    const report = buildProfanityAuditReport({
      events: [event()],
      options,
      pseudonymSalt: 'fixed-test-salt',
    });

    expect(report.samples[0]?.sanitizedText).toBe('ты скотина, пиши [email] или [handle]');
    expect(report.samples[0]?.matchedVariant).toBe('скотина');
    expect(sanitizeProfanityAuditText('https://example.com +7 999 111-22-33')).toBe(
      '[url] [phone]',
    );
  });

  it('reports deletion and follow-up sanction as separate decision axes', () => {
    const options = readProfanityAuditCliOptions([
      '--since',
      '2026-08-23T00:00:00.000Z',
      '--until',
      '2026-08-25T00:00:00.000Z',
    ]);
    const report = buildProfanityAuditReport({
      events: [
        event({
          ruleCode: 'PROFANITY_DELETE',
          action: 'DELETE_MESSAGE',
          metadata: { ...(event().metadata as object), moderationDeleteVerified: true },
        }),
        event({ id: 'warning-1', action: 'WARN', metadata: null }),
      ],
      options,
      truncated: true,
      pseudonymSalt: 'fixed-test-salt',
    });

    expect(report.truncated).toBe(true);
    expect(report.deletionCounts).toEqual({ DELETED: 1 });
    expect(report.sanctionActionCounts).toEqual({ WARN: 1 });
    expect(report.rolloutModeCounts).toEqual({ on: 1 });
    expect(report.familyCounts).toEqual({ 'exact:скотин': 1 });
    expect(report.evidenceCounts).toEqual({ TARGET_CONTEXT: 1 });
  });

  it('marks partially structured built-in decisions as incomplete', () => {
    const options = readProfanityAuditCliOptions([]);
    const report = buildProfanityAuditReport({
      events: [event({ metadata: { detectorVersion: 'profanity-v2' } })],
      options,
      pseudonymSalt: 'fixed-test-salt',
    });

    expect(report.missingStructuredMetadata).toBe(1);
  });

  it('never infers deletion from a DELETE name, action or string-valued proof', () => {
    const report = buildProfanityAuditReport({
      events: [{}, { moderationDeleteVerified: 'true' }, { moderationDeleteVerified: false }].map(
        (metadata, index) =>
          event({
            id: String(index),
            messageId: String(index),
            ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
            action: 'DELETE_MESSAGE',
            metadata,
          }),
      ),
      options: readProfanityAuditCliOptions([]),
    });
    expect(report.deletionCounts).toEqual({ NOT_CONFIRMED: 3 });
  });

  it('separates words, domains and OCR and excludes configured text even with opt-in', () => {
    const report = buildProfanityAuditReport({
      events: [
        event({
          ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
          metadata: {
            moderationDeleteVerified: true,
            matchedVariant: 'private-rule',
          },
          action: 'DELETE_MESSAGE',
        }),
        event({
          id: 'domain',
          ruleCode: 'MESSAGE_BLOCKED_DOMAIN_DELETE',
          metadata: {},
          action: 'DELETE_MESSAGE',
        }),
        event({
          id: 'ocr',
          ruleCode: 'COMMERCIAL_OCR_DELETE',
          metadata: {
            source: 'image_text_ocr',
            matchedRuleCode: 'MESSAGE_BLOCKED_WORD',
            moderationDeleteVerified: true,
            familyId: 'private-configured-rule',
            matchKind: 'private-rule',
            evidence: ['private-recognized-text'],
            detectorVersion: 'private-source',
          },
          action: 'DELETE_MESSAGE',
        }),
        event({ id: 'commercial', ruleCode: 'COMMERCIAL_OCR_DELETE', metadata: {} }),
      ],
      options: readProfanityAuditCliOptions(['--include-sanitized-text']),
    });
    expect(report.uniqueDecisions).toBe(3);
    expect(report.categoryCounts).toEqual({
      CHAT_STOP_LIST: 1,
      CHAT_STOP_LIST_DOMAIN: 1,
      CHAT_STOP_LIST_OCR_WORD: 1,
    });
    expect(report.deletionCounts).toEqual({ DELETED: 2, NOT_CONFIRMED: 1 });
    expect(report.samples.every((sample) => !sample.sanitizedText && !sample.matchedVariant)).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toContain('private-rule');
    expect(JSON.stringify(report)).not.toContain('private-');
  });
});
