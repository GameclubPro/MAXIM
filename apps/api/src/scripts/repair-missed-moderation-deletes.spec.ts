import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildRepairIntentInput,
  evaluateRepairCandidate,
  readRepairCliOptions,
  REPAIR_DEFAULT_BATCH_SIZE,
  REPAIR_DEFAULT_GLOBAL_CAP,
  REPAIR_DEFAULT_PER_CHAT_CAP,
  REPAIR_DEFAULT_WINDOW_HOURS,
  REPAIR_MISSED_DELETES_USAGE,
  REPAIR_ORDINARY_DELETE_RULE_CODES,
  resolveRepairBootstrapMode,
  SCHEDULED_BOT_DELETE_REASON,
  type RepairCandidateRow,
  toDeleteRuleCode,
} from './repair-missed-moderation-deletes.util';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function candidate(overrides: Partial<RepairCandidateRow> = {}): RepairCandidateRow {
  return {
    claimId: 'claim-1',
    claimCreatedAt: new Date('2026-07-16T11:00:00.000Z'),
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: 'message-1',
    claimRuleCode: 'MESSAGE_BLOCKED_WORD',
    updateType: 'message_created',
    entityType: 'CHAT',
    chatBotId: 'bot-fallback',
    chatPrimaryBotId: 'bot-primary',
    evidenceEventId: 'event-1',
    evidenceCreatedAt: new Date('2026-07-16T11:00:01.000Z'),
    evidenceBotId: 'bot-evidence',
    evidenceEventType: 'MESSAGE',
    evidenceRuleCode: 'MESSAGE_BLOCKED_WORD',
    evidenceAction: 'WARN',
    evidenceMaskedExcerpt: 'masked',
    evidenceScore: 0.9,
    evidenceMetadata: { reason: 'blocked word' },
    confirmedDeleteEventId: null,
    existingIntentId: null,
    existingIntentStatus: null,
    existingIntentExecuteAt: null,
    existingIntentOriginBotId: null,
    existingIntentReasons: [],
    ...overrides,
  };
}

describe('repair missed moderation deletes', () => {
  it('defaults to a bounded 24-hour dry-run', () => {
    const options = readRepairCliOptions([], NOW);

    expect(options).toMatchObject({
      execute: false,
      help: false,
      chatIds: [],
      globalCap: REPAIR_DEFAULT_GLOBAL_CAP,
      perChatCap: REPAIR_DEFAULT_PER_CHAT_CAP,
      batchSize: REPAIR_DEFAULT_BATCH_SIZE,
    });
    expect(options.until).toEqual(NOW);
    expect(options.since).toEqual(
      new Date(NOW.getTime() - REPAIR_DEFAULT_WINDOW_HOURS * 60 * 60_000),
    );
    expect(options.scanCap).toBeGreaterThanOrEqual(options.globalCap);
  });

  it('requires explicit execute and enforces all operational bounds', () => {
    expect(
      readRepairCliOptions(
        [
          '--execute',
          '--window-hours',
          '48',
          '--global-cap',
          '40',
          '--per-chat-cap',
          '4',
          '--batch-size',
          '20',
          '--scan-cap',
          '100',
          '--chat-id',
          ' chat-1,chat-2 ',
          '--chat-id',
          'chat-2,chat-3',
        ],
        NOW,
      ),
    ).toMatchObject({
      execute: true,
      chatIds: ['chat-1', 'chat-2', 'chat-3'],
      globalCap: 40,
      perChatCap: 4,
      batchSize: 20,
      scanCap: 100,
    });
    expect(() => readRepairCliOptions(['--window-hours', '169'], NOW)).toThrow('at most 168');
    expect(() => readRepairCliOptions(['--global-cap', '5001'], NOW)).toThrow('between 1 and 5000');
    expect(() => readRepairCliOptions(['--global-cap', '100', '--scan-cap', '99'], NOW)).toThrow(
      '--scan-cap must be greater',
    );
    expect(() => readRepairCliOptions(['--execute', '--dry-run'], NOW)).toThrow(
      'cannot be used together',
    );
    expect(() => readRepairCliOptions(['--concurrency', '3'], NOW)).toThrow('Unknown option');
    expect(() => readRepairCliOptions(['--chat-id', ','], NOW)).toThrow('non-empty chat IDs');
    expect(() => readRepairCliOptions(['--chat-id'], NOW)).toThrow('requires a value');
  });

  it('documents that chat allowlists apply to both dry-run and execute', () => {
    expect(REPAIR_MISSED_DELETES_USAGE).toContain('--chat-id <id[,id...]>');
    expect(REPAIR_MISSED_DELETES_USAGE).toContain('both dry-run and execute');
    expect(readRepairCliOptions(['--help'], NOW)).toMatchObject({ help: true, chatIds: [] });
  });

  it('applies the chat allowlist inside the bounded claim query before its limit', () => {
    const source = readFileSync(resolve(__dirname, 'repair-missed-moderation-deletes.ts'), 'utf8');
    const chatScopeIndex = source.indexOf('AND claim."chat_id" IN');
    const claimBatchLimitIndex = source.indexOf('LIMIT ${limit}');

    expect(chatScopeIndex).toBeGreaterThan(-1);
    expect(claimBatchLimitIndex).toBeGreaterThan(chatScopeIndex);
    expect(source).toContain('${chatScopeSql}');
  });

  it('types repair window parameters before timestamp arithmetic', () => {
    const source = readFileSync(resolve(__dirname, 'repair-missed-moderation-deletes.ts'), 'utf8');

    expect(source).toContain('CAST(${options.since} AS TIMESTAMP)');
    expect(source).toContain('CAST(${options.until} AS TIMESTAMP)');
    expect(source).not.toContain('${options.since} - INTERVAL');
    expect(source).not.toContain('${options.until} + INTERVAL');
  });

  it('keeps dry-run on direct Prisma and permits Nest bootstrap only for admin execute', () => {
    expect(resolveRepairBootstrapMode({ execute: false }, undefined)).toBe(
      'direct_prisma_read_only',
    );
    expect(resolveRepairBootstrapMode({ execute: false }, 'action')).toBe(
      'direct_prisma_read_only',
    );
    expect(resolveRepairBootstrapMode({ execute: true }, 'admin')).toBe('admin_app_context');
    for (const role of [undefined, 'all', 'action', 'moderation', 'enqueue']) {
      expect(() => resolveRepairBootstrapMode({ execute: true }, role)).toThrow(
        '--execute must run with APP_ROLE=admin',
      );
    }
  });

  it('rejects unknown claims and accepts every explicit unambiguous delete family', () => {
    expect(evaluateRepairCandidate(candidate({ claimRuleCode: 'FUTURE_RULE' }))).toMatchObject({
      eligible: false,
      reason: 'unsupported_rule_update_pair',
    });
    expect(toDeleteRuleCode('FUTURE_RULE')).toBe('FUTURE_RULE_DELETE');
    expect(toDeleteRuleCode('NIGHT_MODE_DELETE')).toBe('NIGHT_MODE_DELETE');

    for (const claimRuleCode of REPAIR_ORDINARY_DELETE_RULE_CODES) {
      const evidenceMetadata =
        claimRuleCode === 'COMMERCIAL_AD' ? { actionBand: 'DELETE' } : { reason: 'violation' };
      expect(evaluateRepairCandidate(candidate({ claimRuleCode, evidenceMetadata }))).toMatchObject(
        {
          eligible: true,
          family: 'ordinary_violation',
          intentRuleCode: toDeleteRuleCode(claimRuleCode),
        },
      );
    }
    expect(
      evaluateRepairCandidate(
        candidate({ claimRuleCode: 'LINK_BLOCKED', updateType: 'message_edited' }),
      ),
    ).toMatchObject({ eligible: true, family: 'ordinary_violation' });

    const supported = [
      ['DUPLICATE', 'message_action', 'duplicate', 'DUPLICATE_DELETE'],
      ['DUPLICATE_HIT', 'message_action', 'duplicate_hit', 'DUPLICATE_DELETE'],
      ['MUTE_ACTIVE_DELETE', 'message_action', 'active_mute', 'MUTE_ACTIVE_DELETE'],
      ['NIGHT_MODE_DELETE', 'message_action', 'night_mode', 'NIGHT_MODE_DELETE'],
      [
        'MANUAL_GROUP_CLOSE_DELETE',
        'message_action',
        'manual_group_close',
        'MANUAL_GROUP_CLOSE_DELETE',
      ],
      [
        'REQUIRED_SUBSCRIPTION',
        'message_action',
        'required_subscription',
        'REQUIRED_SUBSCRIPTION_DELETE',
      ],
      [
        'INVITATION_ACCESS_REQUIRED',
        'message_action',
        'invitation_access',
        'INVITATION_ACCESS_REQUIRED_DELETE',
      ],
    ] as const;
    for (const [claimRuleCode, updateType, family, intentRuleCode] of supported) {
      expect(evaluateRepairCandidate(candidate({ claimRuleCode, updateType }))).toMatchObject({
        eligible: true,
        family,
        intentRuleCode,
      });
    }
  });

  it('rejects repair candidates that cannot identify the original bot', () => {
    expect(
      evaluateRepairCandidate(
        candidate({
          existingIntentOriginBotId: null,
          evidenceBotId: null,
          chatPrimaryBotId: null,
          chatBotId: null,
        }),
      ),
    ).toEqual({ eligible: false, reason: 'missing_origin_bot' });
  });

  it('requires the exact update type for every supported family', () => {
    expect(
      evaluateRepairCandidate(
        candidate({ claimRuleCode: 'DUPLICATE', updateType: 'message_created' }),
      ),
    ).toEqual({ eligible: false, reason: 'unsupported_rule_update_pair' });
    expect(
      evaluateRepairCandidate(
        candidate({ claimRuleCode: 'MESSAGE_BLOCKED_WORD', updateType: 'message_action' }),
      ),
    ).toEqual({ eligible: false, reason: 'unsupported_rule_update_pair' });
    expect(evaluateRepairCandidate(candidate({ entityType: 'CHANNEL' }))).toEqual({
      eligible: false,
      reason: 'unsupported_rule_update_pair',
    });
  });

  it('excludes confirmed deletes and terminal intents before intake', () => {
    expect(
      evaluateRepairCandidate(candidate({ confirmedDeleteEventId: 'delete-event-1' })),
    ).toEqual({ eligible: false, reason: 'confirmed_delete_event' });
    expect(
      evaluateRepairCandidate(
        candidate({ existingIntentId: 'intent-1', existingIntentStatus: 'FAILED_TERMINAL' }),
      ),
    ).toEqual({ eligible: false, reason: 'terminal_intent' });
    expect(
      evaluateRepairCandidate(
        candidate({ existingIntentId: 'intent-1', existingIntentStatus: 'WAITING_CAPABILITY' }),
      ),
    ).toMatchObject({ eligible: true });
    expect(
      evaluateRepairCandidate(
        candidate({ existingIntentId: 'intent-shadow', existingIntentStatus: 'OBSERVED' }),
      ),
    ).toMatchObject({ eligible: true });
  });

  it('excludes commercial REVIEW_ONLY and non-actionable evidence exactly', () => {
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'COMMERCIAL_AD',
          evidenceMetadata: { actionBand: 'REVIEW_ONLY', actionable: true },
        }),
      ),
    ).toEqual({ eligible: false, reason: 'commercial_review_only' });
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'COMMERCIAL_AD',
          evidenceMetadata: { actionBand: 'DELETE', actionable: false },
        }),
      ),
    ).toEqual({ eligible: false, reason: 'commercial_not_actionable' });
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'COMMERCIAL_AD',
          evidenceMetadata: { actionBand: 'WARN' },
        }),
      ),
    ).toMatchObject({ eligible: true });
  });

  it('retains the original delayed-delete schedule and rejects missing schedule evidence', () => {
    const evidenceCreatedAt = new Date('2026-07-16T10:00:00.000Z');
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'BOT_MESSAGE_AUTO_DELETE',
          updateType: 'message_action',
          evidenceCreatedAt,
          evidenceRuleCode: 'BOT_MESSAGE_AUTO_DELETE',
          evidenceAction: 'DELETE_MESSAGE',
          evidenceMetadata: { delayMinutes: 2, reason: SCHEDULED_BOT_DELETE_REASON },
        }),
      ),
    ).toMatchObject({
      eligible: true,
      executeAt: new Date('2026-07-16T10:02:00.000Z'),
      family: 'bot_message_auto_delete',
      intentRuleCode: 'BOT_MESSAGE_AUTO_DELETE',
    });
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'BOT_MESSAGE_AUTO_DELETE',
          updateType: 'message_action',
          evidenceMetadata: null,
        }),
      ),
    ).toEqual({ eligible: false, reason: 'bot_auto_delete_missing_schedule_evidence' });
  });

  it('rejects kick-only and synthetic service claims without message-delete evidence', () => {
    for (const claimRuleCode of ['BOT_ACCOUNT_KICK', 'GLOBAL_SPAMMER_KICK'] as const) {
      expect(
        evaluateRepairCandidate(
          candidate({
            claimRuleCode,
            updateType: 'message_action',
            evidenceEventId: null,
            evidenceMetadata: null,
          }),
        ),
      ).toEqual({ eligible: false, reason: 'ambiguous_delete_evidence' });
    }
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'GLOBAL_SPAMMER_KICK',
          updateType: 'user_added',
          messageId: 'service:member-added:123',
          evidenceEventType: 'MEMBER_ACTION',
          evidenceAction: 'KICK',
          evidenceMetadata: {
            reason: 'Member joined via service event and exists in global spammer registry',
          },
        }),
      ),
    ).toEqual({ eligible: false, reason: 'unsupported_rule_update_pair' });
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'BOT_ACCOUNT_KICK',
          updateType: 'message_action',
          evidenceEventType: 'MEMBER_ACTION',
          evidenceAction: 'KICK',
          evidenceMetadata: {
            reason:
              'Bot account removed from service event because bot accounts are disallowed by chat settings',
          },
        }),
      ),
    ).toEqual({ eligible: false, reason: 'ambiguous_delete_evidence' });
  });

  it('accepts explicitly evidenced bot-account and spammer message cleanup only', () => {
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'BOT_ACCOUNT_KICK',
          updateType: 'message_action',
          evidenceEventType: 'MEMBER_ACTION',
          evidenceAction: 'KICK',
          evidenceMetadata: {
            reason: 'Bot account removed because bot accounts are disallowed by chat settings',
          },
        }),
      ),
    ).toMatchObject({
      eligible: true,
      family: 'bot_account_message',
      intentRuleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
    });
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'LOCAL_ADMIN_BLOCK',
          updateType: 'message_action',
          evidenceEventType: 'MEMBER_ACTION',
          evidenceAction: 'KICK',
          evidenceMetadata: { reason: 'Local admin block for this admin scope' },
        }),
      ),
    ).toMatchObject({
      eligible: true,
      family: 'local_admin_block_message',
      intentRuleCode: 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
    });
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'GLOBAL_SPAMMER_KICK',
          updateType: 'message_action',
          evidenceEventType: 'MEMBER_ACTION',
          evidenceAction: 'KICK',
          evidenceMetadata: { reason: 'Sender exists in global spammer registry' },
        }),
      ),
    ).toMatchObject({
      eligible: true,
      family: 'global_spammer_message',
      intentRuleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
    });
  });

  it('accepts an exact observed intent reason when legacy evidence is absent', () => {
    expect(
      evaluateRepairCandidate(
        candidate({
          claimRuleCode: 'GLOBAL_SPAMMER_KICK',
          updateType: 'message_action',
          evidenceEventId: null,
          evidenceMetadata: null,
          existingIntentId: 'intent-shadow',
          existingIntentStatus: 'OBSERVED',
          existingIntentReasons: [
            {
              reasonKey: 'GLOBAL_SPAMMER:known-message-delete',
              ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
              metadata: { reason: 'Sender exists in global spammer registry' },
            },
          ],
        }),
      ),
    ).toMatchObject({ eligible: true, family: 'global_spammer_message' });
  });

  it('preserves source evidence and builds an origin-pinned bot-message intent', () => {
    const row = candidate({
      claimRuleCode: 'BOT_MESSAGE_AUTO_DELETE',
      updateType: 'message_action',
      evidenceRuleCode: 'BOT_MESSAGE_AUTO_DELETE',
      evidenceAction: 'DELETE_MESSAGE',
      evidenceMetadata: { delayMinutes: 2, reason: SCHEDULED_BOT_DELETE_REASON },
    });
    const decision = evaluateRepairCandidate(row);
    if (!decision.eligible) {
      throw new Error(`Expected eligible candidate, got ${decision.reason}`);
    }
    const input = buildRepairIntentInput(row, decision);

    expect(input).toMatchObject({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'repair-missed-delete:bot_message_auto_delete:claim-1',
      ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
      messageAuthorKind: 'bot',
      originBotId: 'bot-evidence',
      routingPolicy: 'origin_only',
      event: {
        userId: 'user-1',
        eventType: 'MESSAGE',
        maskedExcerpt: 'masked',
        score: 0.9,
        metadata: {
          originalEventMetadata: {
            delayMinutes: 2,
            reason: SCHEDULED_BOT_DELETE_REASON,
          },
          repair: {
            claimId: 'claim-1',
            originalEventId: 'event-1',
            originalEventAction: 'DELETE_MESSAGE',
          },
        },
      },
    });
  });
});
