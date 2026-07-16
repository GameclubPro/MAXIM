import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertDuplicateCloseNoticeRepairExecutionMode,
  buildDuplicateCloseNoticeRepairIntentInput,
  DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_GLOBAL_CAP,
  DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_SAMPLE_LIMIT,
  DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_WINDOW_HOURS,
  DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE,
  evaluateDuplicateCloseNoticeRepairCandidate,
  readDuplicateCloseNoticeRepairCliOptions,
  resolveDuplicateCloseNoticeRepairBootstrapMode,
  type DuplicateCloseNoticeRepairCandidate,
} from './repair-duplicate-night-mode-close-notices.util';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function candidate(
  overrides: Partial<DuplicateCloseNoticeRepairCandidate> = {},
): DuplicateCloseNoticeRepairCandidate {
  return {
    id: 'event-old-1',
    createdAt: new Date('2026-07-16T10:00:00.000Z'),
    chatId: 'chat-1',
    userId: 'bot-user-1',
    messageId: 'message-old-1',
    botId: 'bot-1',
    entityType: 'CHAT',
    maskedExcerpt: 'masked',
    score: 0.1,
    sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-15',
    keptEventId: 'event-new-1',
    keptMessageId: 'message-new-1',
    duplicateEvents: 2n,
    ...overrides,
  };
}

describe('duplicate night mode close notice repair', () => {
  it('defaults to a bounded read-only dry-run', () => {
    const options = readDuplicateCloseNoticeRepairCliOptions([], NOW);

    expect(options).toEqual({
      since: new Date(
        NOW.getTime() - DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_WINDOW_HOURS * 60 * 60_000,
      ),
      until: NOW,
      execute: false,
      json: false,
      globalCap: DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_GLOBAL_CAP,
      sampleLimit: DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_SAMPLE_LIMIT,
    });
    expect(resolveDuplicateCloseNoticeRepairBootstrapMode(options, undefined)).toBe(
      'direct_prisma_read_only',
    );
  });

  it('requires explicit execute and enforces the window and global cap bounds', () => {
    expect(
      readDuplicateCloseNoticeRepairCliOptions(
        [
          '--execute',
          '--window-hours',
          '48',
          '--global-cap',
          '500',
          '--sample-limit',
          '50',
          '--json',
        ],
        NOW,
      ),
    ).toMatchObject({ execute: true, globalCap: 500, sampleLimit: 50, json: true });
    expect(readDuplicateCloseNoticeRepairCliOptions(['--limit', '25'], NOW).globalCap).toBe(25);
    expect(() => readDuplicateCloseNoticeRepairCliOptions(['--window-hours', '169'], NOW)).toThrow(
      'at most 168',
    );
    expect(() => readDuplicateCloseNoticeRepairCliOptions(['--global-cap', '1001'], NOW)).toThrow(
      'between 1 and 1000',
    );
    expect(() =>
      readDuplicateCloseNoticeRepairCliOptions(
        ['--since', '2026-07-01T00:00:00.000Z', '--until', '2026-07-16T00:00:00.000Z'],
        NOW,
      ),
    ).toThrow('cannot exceed 168 hours');
    expect(() => readDuplicateCloseNoticeRepairCliOptions(['--execute', '--dry-run'], NOW)).toThrow(
      'cannot be used together',
    );
    expect(() => readDuplicateCloseNoticeRepairCliOptions(['--concurrency', '2'], NOW)).toThrow(
      'Unknown option',
    );
  });

  it('permits application bootstrap only for exact APP_ROLE=admin execute', () => {
    expect(resolveDuplicateCloseNoticeRepairBootstrapMode({ execute: true }, 'admin')).toBe(
      'admin_app_context',
    );
    for (const role of [undefined, '', 'Admin', ' admin', 'admin ', 'action']) {
      expect(() => resolveDuplicateCloseNoticeRepairBootstrapMode({ execute: true }, role)).toThrow(
        'exact APP_ROLE=admin',
      );
    }
    expect(resolveDuplicateCloseNoticeRepairBootstrapMode({ execute: false }, 'action')).toBe(
      'direct_prisma_read_only',
    );
  });

  it('permits intake only in canary or on mode', () => {
    expect(() => assertDuplicateCloseNoticeRepairExecutionMode('canary')).not.toThrow();
    expect(() => assertDuplicateCloseNoticeRepairExecutionMode('on')).not.toThrow();
    for (const mode of [undefined, 'off', 'shadow', 'ON']) {
      expect(() => assertDuplicateCloseNoticeRepairExecutionMode(mode)).toThrow(
        'MODERATION_DELETE_INTENT_MODE=canary or on',
      );
    }
  });

  it('fails closed without the exact origin bot and never targets the kept message', () => {
    expect(evaluateDuplicateCloseNoticeRepairCandidate(candidate({ botId: null }))).toEqual({
      eligible: false,
      reason: 'missing_origin_bot',
    });
    expect(evaluateDuplicateCloseNoticeRepairCandidate(candidate({ botId: '   ' }))).toEqual({
      eligible: false,
      reason: 'missing_origin_bot',
    });
    expect(
      evaluateDuplicateCloseNoticeRepairCandidate(candidate({ keptMessageId: 'message-old-1' })),
    ).toEqual({ eligible: false, reason: 'same_as_kept_message' });
    expect(
      evaluateDuplicateCloseNoticeRepairCandidate(candidate({ entityType: 'CHANNEL' })),
    ).toEqual({ eligible: false, reason: 'unsupported_entity' });
  });

  it('builds only an origin-bound durable delete intent with safe event evidence', () => {
    const row = candidate({ botId: ' bot-1 ' });
    const decision = evaluateDuplicateCloseNoticeRepairCandidate(row);
    expect(decision).toEqual({ eligible: true, originBotId: 'bot-1' });
    if (!decision.eligible) {
      throw new Error('Expected candidate to be eligible');
    }

    expect(buildDuplicateCloseNoticeRepairIntentInput(row, decision)).toEqual({
      chatId: 'chat-1',
      messageId: 'message-old-1',
      reasonKey: DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE,
      ruleCode: DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE,
      subjectUserId: 'bot-user-1',
      sourceMessageAt: new Date('2026-07-16T10:00:00.000Z'),
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'bot-1',
      routingPolicy: 'origin_only',
      event: {
        userId: 'bot-user-1',
        eventType: 'SYSTEM',
        maskedExcerpt: 'masked',
        score: 0.1,
        metadata: {
          reason: 'Repair duplicate night mode close notice',
          repaired: true,
          originalEventId: 'event-old-1',
          originalBotId: 'bot-1',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-15',
          keptEventId: 'event-new-1',
          keptMessageId: 'message-new-1',
          duplicateEvents: 2,
        },
      },
    });
  });

  it('keeps dry-run free of AppModule and direct MAX delete code', () => {
    const source = readFileSync(
      resolve(__dirname, 'repair-duplicate-night-mode-close-notices.ts'),
      'utf8',
    );
    const roleGuardIndex = source.indexOf('resolveDuplicateCloseNoticeRepairBootstrapMode(');
    const appModuleImportIndex = source.indexOf("import('../app.module')");

    expect(source).not.toContain("from '../app.module'");
    expect(source).not.toContain('MaxClientService');
    expect(source).not.toContain('.deleteMessage(');
    expect(roleGuardIndex).toBeGreaterThanOrEqual(0);
    expect(appModuleImportIndex).toBeGreaterThan(roleGuardIndex);
  });

  it('prefers current source over a potentially stale local dist entrypoint', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const command = packageJson.scripts['night-mode:repair-duplicate-close-notices'];

    expect(command).toContain('if [ -f src/scripts/repair-duplicate-night-mode-close-notices.ts ]');
    expect(command).toContain(
      'node --import tsx src/scripts/repair-duplicate-night-mode-close-notices.ts',
    );
    expect(
      command.indexOf('src/scripts/repair-duplicate-night-mode-close-notices.ts'),
    ).toBeLessThan(
      command.indexOf('dist/apps/api/src/scripts/repair-duplicate-night-mode-close-notices.js'),
    );
  });
});
