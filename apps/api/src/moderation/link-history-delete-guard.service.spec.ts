import { ConfigService } from '@nestjs/config';

import { LinkHistoryDeleteGuardService } from './link-history-delete-guard.service';
import {
  LINK_BLOCKED_DELETE_RULE_CODE,
  LINK_HISTORY_RECOVERY_RULE_CODE,
  createMessageContentFingerprint,
} from './link-history-recovery.util';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';

describe('LinkHistoryDeleteGuardService', () => {
  it('rechecks exact content, policy, allowlist and author access before deletion', async () => {
    const harness = buildHarness();

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
  });

  it('guards a live link intent even when history deletion is disabled', async () => {
    const harness = buildHarness({ reasonKind: 'live', deleteEnabled: false });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('allows a live intent after an edit only when the exact message still violates', async () => {
    const harness = buildHarness({
      reasonKind: 'live',
      exactRow: buildMessage({ text: 'changed', url: 'https://changed.example/path' }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('rejects a live intent after the clickable target was removed', async () => {
    const harness = buildHarness({ reasonKind: 'live', exactRow: buildMessageWithoutNavigation() });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_violation_no_longer_present',
    });
  });

  it('rejects a live intent recorded under an older policy revision', async () => {
    const harness = buildHarness({ reasonKind: 'live', settingsRevision: 2 });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_policy_revision_changed',
    });
  });

  it('keeps legacy live intents without a valid policy fence inert', async () => {
    const harness = buildHarness({ reasonKind: 'live', invalidLiveMetadata: true });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_reason_invalid',
    });
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('allows a live edit of a message that predates the current policy baseline', async () => {
    const effectiveAt = new Date();
    const harness = buildHarness({
      reasonKind: 'live',
      settingsEffectiveAt: effectiveAt,
      reasonEffectiveAt: effectiveAt,
      candidateRow: buildMessage({ timestamp: effectiveAt.getTime() - 60_000 }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('rejects a live allowlist-only intent after the target becomes allowed', async () => {
    const harness = buildHarness({
      reasonKind: 'live',
      linkPolicy: 'ALLOWLIST_ONLY',
      allowlist: ['domain:blocked.example'],
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_violation_no_longer_present',
    });
  });

  it('rejects a live intent when the exact message author changes', async () => {
    const harness = buildHarness({
      reasonKind: 'live',
      exactRow: buildMessage({ senderId: 'user-2' }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_message_identity_changed',
    });
  });

  it('fails closed when exact content changed after the candidate was recorded', async () => {
    const harness = buildHarness({
      exactRow: buildMessage({ text: 'changed', url: 'https://changed.example' }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_content_changed',
    });
  });

  it('keeps persisted recovery intents inert while the delete flag is off', async () => {
    const harness = buildHarness({ deleteEnabled: false });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toEqual(
      expect.objectContaining({
        code: 'history_delete_disabled',
      }),
    );

    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('preserves current administrator immunity at dispatch time', async () => {
    const harness = buildHarness({ adminUserIds: ['user-1'] });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_admin_immune',
    });
  });

  it('accepts exact absence only from the message-specific lookup', async () => {
    const harness = buildHarness({ exactRow: null });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('absent');
  });

  it('keeps an explicit plain-text HTTP URL actionable by default', async () => {
    const row = buildPlainTextMessage();
    const harness = buildHarness({ candidateRow: row });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('keeps a fuzzy bare-domain candidate non-actionable by default', async () => {
    const row = buildBareDomainMessage();
    const harness = buildHarness({ candidateRow: row });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_violation_no_longer_present',
    });
  });

  it('allows a fuzzy bare-domain candidate after explicit opt-in', async () => {
    const row = buildBareDomainMessage();
    const harness = buildHarness({ candidateRow: row, textClickabilityEnabled: true });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('fails closed when MAX no longer confirms the current author access', async () => {
    const harness = buildHarness({ remoteAccess: null });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_author_access_unknown',
    });
  });

  it('invalidates an intent created before a scheduled allowlist expiry took effect', async () => {
    const now = Date.now();
    const scheduledAt = new Date(now - 10 * 60_000);
    const expiredAt = new Date(now - 2 * 60_000);
    const row = buildMessage({ timestamp: expiredAt.getTime() - 60_000 });
    const harness = buildHarness({
      candidateRow: row,
      settingsEffectiveAt: scheduledAt,
      reasonEffectiveAt: scheduledAt,
      expiredAllowlistAt: expiredAt,
      linkPolicy: 'ALLOWLIST_ONLY',
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_policy_revision_changed',
    });
  });

  it.each(['domain:example.com', 'https://apps.example.com/start'])(
    'keeps an open_app protected by the live %s matcher',
    async (allowlistEntry) => {
      const row = buildMiniAppMessage();
      const harness = buildHarness({
        candidateRow: row,
        linkPolicy: 'ALLOWLIST_ONLY',
        allowlist: [allowlistEntry],
      });

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'history_violation_no_longer_present',
      });
    },
  );
});

const baseInput = {
  intentId: 'intent-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  botId: 'delete-bot',
};

function buildHarness(
  options: {
    exactRow?: Record<string, unknown> | null;
    candidateRow?: Record<string, unknown>;
    deleteEnabled?: boolean;
    adminUserIds?: string[];
    remoteAccess?: Record<string, unknown> | null;
    settingsEffectiveAt?: Date;
    reasonEffectiveAt?: Date;
    expiredAllowlistAt?: Date | null;
    linkPolicy?: 'ALLOWLIST_ONLY' | 'BLOCKLIST_ONLY';
    allowlist?: string[];
    reasonKind?: 'history' | 'live' | 'mixed';
    settingsRevision?: number;
    invalidLiveMetadata?: boolean;
    textClickabilityEnabled?: boolean;
  } = {},
) {
  const effectiveAt = options.settingsEffectiveAt ?? new Date(Date.now() - 10 * 60_000);
  const reasonEffectiveAt = options.reasonEffectiveAt ?? effectiveAt;
  const defaultExactRow = options.candidateRow ?? buildMessage();
  const exactRow = Object.prototype.hasOwnProperty.call(options, 'exactRow')
    ? (options.exactRow ?? null)
    : defaultExactRow;
  const fingerprint = createMessageContentFingerprint(
    adaptMaxMessageNavigationView(defaultExactRow),
  );
  const historyReason = {
    ruleCode: LINK_HISTORY_RECOVERY_RULE_CODE,
    metadata: {
      contentFingerprint: fingerprint,
      policyRevision: 1,
      policyEffectiveAt: reasonEffectiveAt.toISOString(),
    },
  };
  const liveReason = {
    ruleCode: LINK_BLOCKED_DELETE_RULE_CODE,
    metadata: options.invalidLiveMetadata
      ? { reason: 'legacy reason without a policy fence' }
      : {
          linkPolicyRevision: 1,
          linkPolicyEffectiveAt: reasonEffectiveAt.toISOString(),
        },
  };
  const reasonKind = options.reasonKind ?? 'history';
  const prisma = {
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    moderationDeleteIntentReason: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          reasonKind === 'mixed'
            ? [liveReason, historyReason]
            : [reasonKind === 'live' ? liveReason : historyReason],
        ),
    },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue({
        linkPolicy: options.linkPolicy ?? 'BLOCKLIST_ONLY',
        linkPolicyRevision: options.settingsRevision ?? 1,
        linkPolicyEffectiveAt: effectiveAt,
        chat: {
          admins: (options.adminUserIds ?? []).map((userId) => ({ userId })),
        },
      }),
    },
    domainAllowlist: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.allowlist ?? []).map((domain) => ({ domain }))),
      aggregate: jest.fn().mockResolvedValue({
        _max: { removeAfterAt: options.expiredAllowlistAt ?? null },
      }),
    },
  };
  const maxClient = {
    getExactMessageRow: jest.fn().mockResolvedValue(exactRow),
    getChatMemberAccess: jest.fn().mockResolvedValue(
      options.remoteAccess === undefined
        ? {
            userId: 'user-1',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          }
        : options.remoteAccess,
    ),
  };
  const maxBotLinkService = {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
  };
  const service = new LinkHistoryDeleteGuardService(
    prisma as never,
    maxClient as never,
    maxBotLinkService as never,
    new ConfigService({
      MODERATION_LINK_HISTORY_DELETE_ENABLED: options.deleteEnabled ?? true,
      MODERATION_LINK_TEXT_CLICKABILITY_ENABLED: options.textClickabilityEnabled ?? false,
    }),
  );
  return { service, prisma, maxClient, maxBotLinkService };
}

function buildMessage(
  options: { timestamp?: number; text?: string; url?: string; senderId?: string } = {},
): Record<string, unknown> {
  const text = options.text ?? 'site';
  return {
    id: 'message-1',
    timestamp: options.timestamp ?? Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: options.senderId ?? 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text,
      markup: [
        {
          type: 'link',
          from: 0,
          length: text.length,
          url: options.url ?? 'https://blocked.example/path',
        },
      ],
    },
  };
}

function buildPlainTextMessage(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'Visit https://example.com/blocked',
    },
  };
}

function buildBareDomainMessage(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'Visit example.com/blocked',
    },
  };
}

function buildMessageWithoutNavigation(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'ordinary text',
    },
  };
}

function buildMiniAppMessage(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'Open app',
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                {
                  type: 'open_app',
                  text: 'Open',
                  web_app: 'https://apps.example.com/start',
                },
              ],
            ],
          },
        },
      ],
    },
  };
}
