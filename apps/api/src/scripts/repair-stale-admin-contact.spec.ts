import { buildCompactProfileMentionStartPayload } from '../max/max-deep-link.util';
import { ChatEntityType } from '../prisma/prisma-client';
import {
  createProductionDependencies,
  readStaleAdminContactRepairOptions,
  runStaleAdminContactRepair,
  type StaleAdminContactRepairDependencies,
  type StaleAdminContactRepairState,
} from './repair-stale-admin-contact';

const CHAT_ID = '-100000000001';
const FORMER_ADMIN_ID = '11111111';
const TOKEN = 'test-token-for-stale-admin-contact-repair';
const CLEAN_RULES = 'Правила чата:\n\n1. Не отправляйте ссылки.';
const CONTACT_LABEL = 'СТАРЫЙ АДМИН';
const RULES_UPDATED_AT = new Date('2026-08-01T10:00:00.000Z');
const SETTINGS_UPDATED_AT = new Date('2026-08-01T09:00:00.000Z');

function buildSignedContactUrl(userId = FORMER_ADMIN_ID): string {
  const payload = buildCompactProfileMentionStartPayload(
    { chatId: CHAT_ID, entityType: 'chat', userId },
    TOKEN,
  );
  if (!payload) {
    throw new Error('Test profile payload was not created');
  }
  return `https://max.ru/test_bot?start=${payload}&profile_label=${encodeURIComponent(CONTACT_LABEL)}`;
}

function buildEmptySettings(): NonNullable<StaleAdminContactRepairState['settings']> {
  return {
    updatedAt: SETTINGS_UPDATED_AT,
    requiredSubscriptionAdminContactButtonEnabled: false,
    requiredSubscriptionAdminContactButtonUrl: '',
    invitationAccessAdminContactButtonEnabled: false,
    invitationAccessAdminContactButtonUrl: '',
    messageLimitsAdminContactButtonEnabled: false,
    messageLimitsAdminContactButtonUrl: '',
    phoneNumbersAdminContactButtonEnabled: false,
    phoneNumbersAdminContactButtonUrl: '',
    profanityAdminContactButtonEnabled: false,
    profanityAdminContactButtonUrl: '',
    textFiltersAdminContactButtonEnabled: false,
    textFiltersAdminContactButtonUrl: '',
    linkAdminContactButtonEnabled: false,
    linkAdminContactButtonUrl: '',
    duplicateAdminContactButtonEnabled: false,
    duplicateAdminContactButtonUrl: '',
  };
}

function buildState(
  options: {
    includeStoredContacts?: boolean;
    published?: boolean;
  } = {},
): StaleAdminContactRepairState {
  const contactUrl = buildSignedContactUrl();
  const settings = buildEmptySettings();
  if (options.includeStoredContacts !== false) {
    settings.messageLimitsAdminContactButtonEnabled = true;
    settings.messageLimitsAdminContactButtonUrl = contactUrl;
    settings.profanityAdminContactButtonEnabled = true;
    settings.profanityAdminContactButtonUrl = contactUrl;
    settings.linkAdminContactButtonEnabled = true;
    settings.linkAdminContactButtonUrl = contactUrl;
  }
  return {
    chatId: CHAT_ID,
    entityType: ChatEntityType.CHAT,
    primaryBotId: 'bot-1',
    legacyBotId: 'bot-1',
    membershipBotIds: ['bot-1'],
    settings,
    rules: {
      text: CLEAN_RULES,
      adminContactButtonEnabled: options.includeStoredContacts !== false,
      adminContactButtonUrl: options.includeStoredContacts !== false ? contactUrl : '',
      publishedMessageId: options.published === false ? null : 'message-1',
      publishedBotId: 'bot-1',
      publishOperationId: null,
      publishSendStartedAt: null,
      pendingCleanupMessageId: null,
      updatedAt: RULES_UPDATED_AT,
    },
  };
}

function buildDependencies(state: StaleAdminContactRepairState) {
  const staleRules = `${CLEAN_RULES}\n\nСвязь с админом: ${CONTACT_LABEL}`;
  return {
    validationTokens: [TOKEN],
    loadState: jest.fn().mockResolvedValue(state),
    readLiveAdminStatus: jest.fn().mockResolvedValue({
      botIsAdmin: true,
      expectedUserIsAdmin: false,
    }),
    readPublishedMessageMarkdown: jest.fn().mockResolvedValue(staleRules),
    editPublishedRulesMessage: jest.fn().mockResolvedValue(undefined),
    recordAttempt: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue('applied' as const),
    invalidate: jest.fn().mockResolvedValue(undefined),
  } satisfies StaleAdminContactRepairDependencies;
}

describe('stale admin-contact repair options', () => {
  it('uses dry-run by default and requires explicit identifiers', () => {
    expect(
      readStaleAdminContactRepairOptions([
        '--chat-id',
        CHAT_ID,
        '--expected-user-id',
        FORMER_ADMIN_ID,
        '--json',
      ]),
    ).toEqual({
      apply: false,
      json: true,
      chatId: CHAT_ID,
      expectedUserId: FORMER_ADMIN_ID,
    });
    expect(() => readStaleAdminContactRepairOptions(['--chat-id', CHAT_ID])).toThrow(
      '--expected-user-id is required',
    );
  });

  it('rejects conflicting modes and unknown options', () => {
    expect(() =>
      readStaleAdminContactRepairOptions([
        '--apply',
        '--dry-run',
        '--chat-id',
        CHAT_ID,
        '--expected-user-id',
        FORMER_ADMIN_ID,
      ]),
    ).toThrow('--apply cannot be combined with --dry-run');
    expect(() =>
      readStaleAdminContactRepairOptions([
        '--chat-id',
        CHAT_ID,
        '--expected-user-id',
        FORMER_ADMIN_ID,
        '--all',
      ]),
    ).toThrow('Unknown option: --all');
  });
});

describe('runStaleAdminContactRepair', () => {
  const dryRunOptions = {
    apply: false,
    json: true,
    chatId: CHAT_ID,
    expectedUserId: FORMER_ADMIN_ID,
  };

  it('plans only matching signed contact fields and does not mutate in dry-run', async () => {
    const dependencies = buildDependencies(buildState());

    const summary = await runStaleAdminContactRepair(dependencies, dryRunOptions);

    expect(summary).toMatchObject({
      result: 'ready',
      complete: true,
      rulesContactMatched: true,
      publishedMessageAction: 'would_edit',
    });
    expect(summary.settingsFields).toEqual([
      'messageLimitsAdminContactButtonUrl',
      'profanityAdminContactButtonUrl',
      'linkAdminContactButtonUrl',
    ]);
    expect(dependencies.editPublishedRulesMessage).not.toHaveBeenCalled();
    expect(dependencies.recordAttempt).not.toHaveBeenCalled();
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.invalidate).not.toHaveBeenCalled();
  });

  it('edits the tracked rules message, verifies it, commits, and invalidates', async () => {
    const dependencies = buildDependencies(buildState());
    const order: string[] = [];
    dependencies.recordAttempt.mockImplementation(async () => {
      order.push('started');
    });
    dependencies.editPublishedRulesMessage.mockImplementation(async () => {
      order.push('edited');
    });
    dependencies.commit.mockImplementation(async () => {
      order.push('committed');
      return 'applied';
    });
    dependencies.readPublishedMessageMarkdown
      .mockReset()
      .mockResolvedValueOnce(`${CLEAN_RULES}\n\nСвязь с админом: ${CONTACT_LABEL}`)
      .mockResolvedValueOnce(CLEAN_RULES);

    const summary = await runStaleAdminContactRepair(dependencies, {
      ...dryRunOptions,
      apply: true,
    });

    expect(summary).toMatchObject({
      result: 'applied',
      complete: true,
      publishedMessageAction: 'edited',
    });
    expect(dependencies.editPublishedRulesMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: 'message-1',
      botId: 'bot-1',
      text: CLEAN_RULES,
    });
    expect(dependencies.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT_ID,
        expectedUserId: FORMER_ADMIN_ID,
        publishedMessageEdited: true,
        publishedMessageId: 'message-1',
        publishedMessageBotId: 'bot-1',
        rulesSnapshot: expect.objectContaining({
          expectedText: CLEAN_RULES,
          expectedPublishedMessageId: 'message-1',
          expectedPublishedBotId: 'bot-1',
          expectedUpdatedAt: RULES_UPDATED_AT,
        }),
        settingsSnapshot: expect.objectContaining({
          updatedAt: SETTINGS_UPDATED_AT,
        }),
      }),
    );
    expect(dependencies.invalidate).toHaveBeenCalledWith(CHAT_ID);
    expect(dependencies.recordAttempt).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['started', 'edited', 'committed']);
  });

  it('accepts an ambiguous edit only when readback proves the repaired text', async () => {
    const dependencies = buildDependencies(buildState());
    dependencies.editPublishedRulesMessage.mockRejectedValue(new Error('request timed out'));
    dependencies.readPublishedMessageMarkdown
      .mockReset()
      .mockResolvedValueOnce(`${CLEAN_RULES}\n\nСвязь с админом: ${CONTACT_LABEL}`)
      .mockRejectedValueOnce(new Error('readback timed out'))
      .mockResolvedValueOnce(CLEAN_RULES);

    const summary = await runStaleAdminContactRepair(dependencies, {
      ...dryRunOptions,
      apply: true,
    });

    expect(summary.result).toBe('applied');
    expect(dependencies.commit).toHaveBeenCalledWith(
      expect.objectContaining({ publishedMessageEdited: true }),
    );
  });

  it('refuses apply while the expected user is still a live administrator', async () => {
    const dependencies = buildDependencies(buildState());
    dependencies.readLiveAdminStatus.mockResolvedValue({
      botIsAdmin: true,
      expectedUserIsAdmin: true,
    });

    const summary = await runStaleAdminContactRepair(dependencies, {
      ...dryRunOptions,
      apply: true,
    });

    expect(summary.result).toBe('former_admin_still_admin');
    expect(summary.complete).toBe(false);
    expect(dependencies.editPublishedRulesMessage).not.toHaveBeenCalled();
    expect(dependencies.recordAttempt).not.toHaveBeenCalled();
    expect(dependencies.commit).not.toHaveBeenCalled();
  });

  it('finishes a prior partial repair when only the published message is stale', async () => {
    const dependencies = buildDependencies(buildState({ includeStoredContacts: false }));
    dependencies.readPublishedMessageMarkdown
      .mockReset()
      .mockResolvedValueOnce(
        `${CLEAN_RULES}\n\nСвязь с админом: [${CONTACT_LABEL}](max://user/${FORMER_ADMIN_ID})`,
      )
      .mockResolvedValueOnce(CLEAN_RULES);

    const summary = await runStaleAdminContactRepair(dependencies, {
      ...dryRunOptions,
      apply: true,
    });

    expect(summary.result).toBe('applied');
    expect(dependencies.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        settingsChanges: [],
        rulesChange: null,
        rulesSnapshot: expect.objectContaining({
          expectedPublishedMessageId: 'message-1',
        }),
        publishedMessageEdited: true,
      }),
    );
  });

  it('fails closed for an enabled contact URL that cannot be tied to a user', async () => {
    const state = buildState({ published: false });
    state.settings!.messageLimitsAdminContactButtonUrl = 'https://max.ru/some-user';
    const dependencies = buildDependencies(state);

    const summary = await runStaleAdminContactRepair(dependencies, dryRunOptions);

    expect(summary.result).toBe('invalid_contact_url');
    expect(summary.complete).toBe(false);
    expect(dependencies.readLiveAdminStatus).not.toHaveBeenCalled();
  });

  it('blocks while chat rules publication or cleanup owns the row', async () => {
    const state = buildState();
    state.rules!.publishOperationId = 'publish-in-flight';
    state.rules!.publishSendStartedAt = new Date('2026-08-01T10:01:00.000Z');
    const dependencies = buildDependencies(state);

    const summary = await runStaleAdminContactRepair(dependencies, dryRunOptions);

    expect(summary.result).toBe('rules_publication_in_progress');
    expect(summary.complete).toBe(false);
    expect(dependencies.readLiveAdminStatus).not.toHaveBeenCalled();
    expect(dependencies.editPublishedRulesMessage).not.toHaveBeenCalled();
  });

  it('uses the stored publishing bot even when another bot performs the live check', async () => {
    const state = buildState();
    state.rules!.publishedBotId = 'publisher-bot';
    state.primaryBotId = 'primary-bot';
    state.legacyBotId = 'legacy-bot';
    state.membershipBotIds = ['primary-bot'];
    const dependencies = buildDependencies(state);
    dependencies.readLiveAdminStatus.mockImplementation(async (_chatId, botId) => ({
      botIsAdmin: botId === 'primary-bot',
      expectedUserIsAdmin: false,
    }));

    const summary = await runStaleAdminContactRepair(dependencies, dryRunOptions);

    expect(summary.result).toBe('ready');
    expect(summary.liveCheckBotId).toBe('primary-bot');
    expect(dependencies.readPublishedMessageMarkdown).toHaveBeenCalledWith(
      'message-1',
      'publisher-bot',
    );
  });

  it('retries cache invalidation on an already-clean apply rerun', async () => {
    const state = buildState({ includeStoredContacts: false });
    const dependencies = buildDependencies(state);
    dependencies.readPublishedMessageMarkdown.mockResolvedValue(CLEAN_RULES);

    const summary = await runStaleAdminContactRepair(dependencies, {
      ...dryRunOptions,
      apply: true,
    });

    expect(summary.result).toBe('already_clean');
    expect(summary.complete).toBe(true);
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.invalidate).toHaveBeenCalledWith(CHAT_ID);
  });
});

describe('stale admin-contact production commit', () => {
  it('compare-and-sets the full settings and rules snapshots', async () => {
    const state = buildState();
    const tx = {
      chatSettings: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      chatRules: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      auditLog: { create: jest.fn() },
    };
    const dependencies = createProductionDependencies({
      prisma: prisma as never,
      registry: { getValidationTokens: () => [TOKEN] } as never,
      maxClient: {} as never,
      chatContextCache: {} as never,
    });
    const rulesSnapshot = {
      expectedText: state.rules!.text,
      expectedEnabled: state.rules!.adminContactButtonEnabled,
      expectedUrl: state.rules!.adminContactButtonUrl,
      expectedPublishedMessageId: state.rules!.publishedMessageId,
      expectedPublishedBotId: state.rules!.publishedBotId,
      expectedPublishOperationId: state.rules!.publishOperationId,
      expectedPublishSendStartedAt: state.rules!.publishSendStartedAt,
      expectedPendingCleanupMessageId: state.rules!.pendingCleanupMessageId,
      expectedUpdatedAt: state.rules!.updatedAt,
    };

    await expect(
      dependencies.commit({
        runId: 'repair-run-1',
        chatId: CHAT_ID,
        expectedUserId: FORMER_ADMIN_ID,
        settingsChanges: [
          {
            enabledKey: 'messageLimitsAdminContactButtonEnabled',
            urlKey: 'messageLimitsAdminContactButtonUrl',
            expectedEnabled: true,
            expectedUrl: state.settings!.messageLimitsAdminContactButtonUrl,
          },
        ],
        settingsSnapshot: state.settings,
        rulesChange: rulesSnapshot,
        rulesSnapshot,
        publishedMessageEdited: true,
        publishedMessageId: 'message-1',
        publishedMessageBotId: 'bot-1',
      }),
    ).resolves.toBe('applied');

    expect(tx.chatSettings.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: CHAT_ID,
        updatedAt: SETTINGS_UPDATED_AT,
        messageLimitsAdminContactButtonEnabled: true,
        messageLimitsAdminContactButtonUrl: state.settings!.messageLimitsAdminContactButtonUrl,
        requiredSubscriptionAdminContactButtonEnabled: false,
        requiredSubscriptionAdminContactButtonUrl: '',
        duplicateAdminContactButtonEnabled: false,
        duplicateAdminContactButtonUrl: '',
      }),
      data: {
        messageLimitsAdminContactButtonEnabled: false,
        messageLimitsAdminContactButtonUrl: '',
      },
    });
    expect(tx.chatRules.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: CHAT_ID,
        text: CLEAN_RULES,
        publishedMessageId: 'message-1',
        publishedBotId: 'bot-1',
        publishOperationId: null,
        publishSendStartedAt: null,
        pendingCleanupMessageId: null,
        updatedAt: RULES_UPDATED_AT,
      }),
      data: {
        adminContactButtonEnabled: false,
        adminContactButtonUrl: '',
      },
    });
  });
});
