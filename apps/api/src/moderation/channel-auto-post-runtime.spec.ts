import {
  ChannelAutoPostScanManager,
  buildChannelAutoPostButtons,
  extractChannelAutoPostMessageLinkType,
  isChannelAutoPostMessage,
  parseChannelAutoPostListedMessage,
  resolveChannelAutoPostButtonVisibility,
  resolveChannelAutoPostEventTimestampMs,
  resolveChannelAutoPostMessageText,
  resolveChannelAutoPostMutationBotRoute,
} from './channel-auto-post-runtime';

function createScanManager(now: () => number, states = new Map()) {
  return new ChannelAutoPostScanManager(
    {
      scanIntervalMs: 1_000,
      scanMaxChannels: 8,
      idleBackoffMaxMs: 8_000,
      repairSweepMs: 5_000,
      rateLimitBackoffMs: 100,
      throttleBackoffMaxMs: 500,
      now,
    },
    states,
  );
}

describe('channel auto-post runtime', () => {
  it('builds comments, suggestion, and channel CTA as full-width rows', () => {
    expect(
      buildChannelAutoPostButtons(
        {
          postSuggestionsButtonText: '✍️ Предложить объявление',
          postSuggestionsEntryMode: 'MINIAPP',
        },
        { includeCommentsButton: true, includeSuggestButton: true },
        (type, text) => ({ type: 'link', text, url: `https://max.ru/${type}` }),
        { type: 'link', text: '📞 Заказать рекламу', url: 'https://example.test/ads' },
      ),
    ).toEqual([
      [expect.objectContaining({ text: '💬 Комментарии · 0' })],
      [expect.objectContaining({ text: '✍️ Предложить объявление' })],
      [expect.objectContaining({ text: '📞 Заказать рекламу' })],
    ]);
  });

  it('renders direct and forwarded MAX markup without losing the original text', () => {
    expect(
      resolveChannelAutoPostMessageText(
        {
          body: {
            text: 'Hello world',
            markup: [{ type: 'strong', from: '0', length: '5' }],
          },
        },
        null,
      ),
    ).toEqual({ text: '<strong>Hello</strong> world', textFormat: 'html' });

    expect(
      resolveChannelAutoPostMessageText(
        {
          link: {
            type: 'forward',
            message: {
              body: {
                text: 'Forwarded',
                text_markup: [
                  {
                    type: 'link',
                    from: 0,
                    length: 9,
                    url: 'https://example.com/post',
                  },
                ],
              },
            },
          },
        },
        'fallback',
      ),
    ).toEqual({
      text: '<a href="https://example.com/post">Forwarded</a>',
      textFormat: 'html',
    });
  });

  it('keeps fallback and explicit text-format behavior when markup is absent or invalid', () => {
    expect(resolveChannelAutoPostMessageText(null, 'fallback')).toEqual({
      text: 'fallback',
      textFormat: null,
    });
    expect(
      resolveChannelAutoPostMessageText(
        {
          body: {
            text: 'Markdown',
            format: 'MARKDOWN',
            markup: [{ type: 'unknown', from: 0, length: 8 }],
          },
        },
        null,
      ),
    ).toEqual({ text: 'Markdown', textFormat: 'markdown' });
  });

  it('normalizes listed-message metadata and rejects unusable identities', () => {
    expect(
      parseChannelAutoPostListedMessage({
        body: {
          mid: 42,
          text: 'Post',
          attachments: [{ type: 'INLINE_KEYBOARD' }],
        },
        timestamp: '1234',
        link: { type: 'FORWARD' },
        sender: { user_id: ' admin-1 ' },
      }),
    ).toEqual({
      messageId: '42',
      text: 'Post',
      textFormat: null,
      linkType: 'forward',
      timestampMs: 1234,
      senderId: 'admin-1',
      existingDialogButtonKinds: [],
      existingDialogThreadId: null,
    });
    expect(parseChannelAutoPostListedMessage({ timestamp: 1234 })).toBeNull();
    expect(parseChannelAutoPostListedMessage({ id: 'message-1', timestamp: 'invalid' })).toBeNull();
  });

  it.each([
    ['official post_id', { post_id: 'parent-post-1' }],
    ['camel-case postId alias', { postId: 'parent-post-1' }],
  ])('rejects native channel comments from listed-message history using %s', (_label, parent) => {
    expect(
      parseChannelAutoPostListedMessage({
        body: { mid: 'comment-1', text: 'Native comment' },
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
          ...parent,
        },
        sender: { user_id: 'admin-1' },
        timestamp: 1_777_000_000_000,
      }),
    ).toBeNull();
  });

  it.each([
    ['numeric sender.user_id', { sender: { user_id: 195714583 } }, '195714583'],
    ['sender.userId alias', { sender: { userId: ' user-2 ' } }, 'user-2'],
    ['numeric sender.id alias', { sender: { id: 42 } }, '42'],
    ['numeric top-level sender_id', { sender_id: 777 }, '777'],
    ['top-level senderId alias', { senderId: ' user-3 ' }, 'user-3'],
  ])('normalizes %s in listed-message history', (_label, senderShape, expectedSenderId) => {
    expect(
      parseChannelAutoPostListedMessage({
        id: 'message-1',
        timestamp: 1234,
        ...senderShape,
      })?.senderId,
    ).toBe(expectedSenderId);
  });

  it('rejects unsafe numeric sender IDs instead of rounding them', () => {
    expect(
      parseChannelAutoPostListedMessage({
        id: 'message-1',
        timestamp: 1234,
        sender: { user_id: Number.MAX_SAFE_INTEGER + 1 },
      })?.senderId,
    ).toBeNull();
  });

  it('detects existing internal channel buttons without treating custom or cross-channel links as owned', () => {
    const commentsToken = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: 'comments-thread', s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    expect(
      parseChannelAutoPostListedMessage(
        {
          id: 'message-1',
          timestamp: 1234,
          body: {
            text: 'Post',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [
                      {
                        type: 'link',
                        text: 'Мои комментарии',
                        url: `https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=${commentsToken}`,
                      },
                    ],
                    [
                      {
                        type: 'link',
                        text: 'Предложить',
                        url: `https://max.ru/bot-1?start=cds-channel-1.${'a'.repeat(32)}.${'b'.repeat(24)}`,
                      },
                    ],
                    [
                      {
                        type: 'link',
                        text: 'Другой канал',
                        url: 'https://major-maksimov.ru/app/channel/channel-2/dialog/comments?token=cdt-other',
                      },
                    ],
                    [{ type: 'link', text: 'Сайт', url: 'https://example.com/' }],
                  ],
                },
              },
            ],
          },
        },
        'channel-1',
      ),
    ).toEqual(
      expect.objectContaining({
        existingDialogButtonKinds: ['comments', 'suggest'],
        existingDialogThreadId: 'comments-thread',
      }),
    );
  });

  it('detects channel posts, rejects native comments, and derives button visibility', () => {
    const update = {
      updateId: 'update-1',
      type: 'message_created',
      message: {
        messageId: 'message-1',
        chatId: 'channel-1',
        senderId: 'admin-1',
        text: '',
        createdAt: '2026-07-19T10:00:00.000Z',
      },
      raw: {
        message: {
          recipient: { chat_type: 'CHANNEL' },
          link: { type: 'FORWARD' },
        },
      },
    } as const;

    expect(isChannelAutoPostMessage(update)).toBe(true);
    expect(
      isChannelAutoPostMessage({
        ...update,
        message: { ...update.message, postId: 'channel-post-1' },
      }),
    ).toBe(false);
    for (const parentPostKey of ['post_id', 'postId'] as const) {
      expect(
        isChannelAutoPostMessage({
          ...update,
          raw: {
            message: {
              ...update.raw.message,
              recipient: {
                ...update.raw.message.recipient,
                [parentPostKey]: 'channel-post-1',
              },
            },
          },
        }),
      ).toBe(false);
    }
    expect(extractChannelAutoPostMessageLinkType(update)).toBe('forward');
    expect(resolveChannelAutoPostEventTimestampMs(update, 1)).toBe(
      Date.parse('2026-07-19T10:00:00.000Z'),
    );
    expect([
      resolveChannelAutoPostButtonVisibility({
        commentsEnabled: false,
        postSuggestionsEnabled: false,
      }),
      resolveChannelAutoPostButtonVisibility({
        commentsEnabled: true,
        postSuggestionsEnabled: false,
      }),
      resolveChannelAutoPostButtonVisibility({
        commentsEnabled: false,
        postSuggestionsEnabled: true,
      }),
      resolveChannelAutoPostButtonVisibility({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
      }),
    ]).toEqual([
      { includeCommentsButton: false, includeSuggestButton: false },
      { includeCommentsButton: true, includeSuggestButton: false },
      { includeCommentsButton: false, includeSuggestButton: true },
      { includeCommentsButton: true, includeSuggestButton: true },
    ]);
  });

  it('selects only due channels and rotates large batches fairly', () => {
    let now = 10_000;
    const states = new Map([
      [
        'channel-b',
        {
          latestTimestampMs: 0,
          latestMessageIdsAtTimestamp: [],
          idleStreak: 0,
          nextScanAtMs: 20_000,
        },
      ],
    ]);
    const manager = createScanManager(() => now, states);
    const channels = ['channel-a', 'channel-b', 'channel-c', 'channel-d'].map((chatId) => ({
      chatId,
    }));

    expect(manager.selectBatch(channels, 2).map((item) => item.chatId)).toEqual([
      'channel-a',
      'channel-c',
    ]);
    expect(manager.selectBatch(channels, 2).map((item) => item.chatId)).toEqual([
      'channel-d',
      'channel-a',
    ]);
    now = 20_000;
    expect(manager.selectBatch(channels, 8)).toEqual(channels);
  });

  it('tracks equal-timestamp ids, idle scheduling, webhook repair, and throttle backoff', () => {
    const now = 10_000;
    const manager = createScanManager(() => now);
    let state = manager.advance(null, { messageId: 'message-0', timestampMs: 500 });

    for (let index = 1; index < 12; index += 1) {
      state = manager.advance(state, { messageId: `message-${index}`, timestampMs: 500 });
    }
    expect(state.latestMessageIdsAtTimestamp).toHaveLength(10);
    expect(state.latestMessageIdsAtTimestamp[0]).toBe('message-2');
    expect(manager.isMessageNew(state, { messageId: 'message-11', timestampMs: 500 })).toBe(false);
    expect(manager.isMessageNew(state, { messageId: 'message-12', timestampMs: 500 })).toBe(true);

    const idleOnce = manager.schedule(state, false);
    expect(idleOnce).toMatchObject({ idleStreak: 1, nextScanAtMs: 12_000 });
    const idleTwice = manager.schedule(idleOnce, false);
    expect(idleTwice).toMatchObject({ idleStreak: 2, nextScanAtMs: 14_000 });
    expect(manager.schedule(idleTwice, true)).toMatchObject({
      idleStreak: 0,
      nextScanAtMs: 11_000,
    });

    manager.markWebhookSeen('channel-1', 'message-webhook', 700);
    expect(manager.states.get('channel-1')).toMatchObject({
      latestTimestampMs: 700,
      latestMessageIdsAtTimestamp: ['message-webhook'],
      idleStreak: 0,
      nextScanAtMs: 15_000,
    });

    expect(manager.recordTransientThrottle('channel-1')).toBe(100);
    expect(manager.resolveBatchSize()).toBe(4);
    expect(manager.recordTransientThrottle('channel-1')).toBe(200);
    expect(manager.resolveBatchSize()).toBe(2);
    expect(manager.recordTransientThrottle('channel-1')).toBe(400);
    expect(manager.recordTransientThrottle('channel-1')).toBe(500);
    expect(manager.resolveBatchSize()).toBe(1);
    manager.resetThrottle();
    expect(manager.resolveBatchSize()).toBe(8);
  });

  it('filters scan messages and preserves the first unprocessed message at the attempt limit', async () => {
    const manager = createScanManager(() => 10_000);
    const attach = jest.fn().mockResolvedValue('attached');
    const messages = [
      { id: 'valid-next', timestamp: 104, body: { text: 'Next' } },
      {
        id: 'keyboard',
        timestamp: 102,
        body: { text: 'Done', attachments: [{ type: 'inline_keyboard' }] },
      },
      {
        id: 'comment',
        timestamp: 102,
        recipient: { chat_id: 'channel-1', chat_type: 'channel', post_id: 'post-1' },
        sender_id: 'admin-1',
        body: { text: 'Native comment' },
      },
      { id: 'non-admin', timestamp: 100, sender_id: 'user-1', body: { text: 'Skip' } },
      { id: 'valid', timestamp: 103, sender_id: 'admin-1', body: { text: 'Publish' } },
      { id: 'before-settings', timestamp: 101, body: { text: 'Old' } },
    ];

    await manager.processListedMessages({
      chatId: 'channel-1',
      messages,
      adminUserIds: ['admin-1'],
      settingsUpdatedAtMs: 102,
      maxNewMessagesPerScan: 1,
      attach,
    });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'keyboard' }));
    expect(manager.states.get('channel-1')).toMatchObject({
      latestTimestampMs: 102,
      latestMessageIdsAtTimestamp: ['keyboard'],
      idleStreak: 0,
      nextScanAtMs: 11_000,
    });
  });

  it('processes posts with an existing inline keyboard for repair', async () => {
    const manager = createScanManager(() => 10_000);
    const attach = jest.fn().mockResolvedValue('attached');

    await manager.processListedMessages({
      chatId: 'channel-1',
      messages: [
        {
          id: 'signed-repair',
          timestamp: 103,
          body: {
            text: 'Пост',
            attachments: [{ type: 'inline_keyboard', payload: { buttons: [] } }],
          },
        },
      ],
      adminUserIds: [],
      settingsUpdatedAtMs: 102,
      maxNewMessagesPerScan: 1,
      attach,
    });

    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'signed-repair',
      }),
    );
  });

  it('does not filter ordinary channel posts by sender identity during polling', async () => {
    const manager = createScanManager(() => 10_000);
    const attach = jest.fn().mockResolvedValue('attached');

    await manager.processListedMessages({
      chatId: 'channel-1',
      messages: [
        {
          id: 'admin-authored-post',
          timestamp: 103,
          sender_id: 'admin-1',
          body: { text: 'Пост администратора' },
        },
      ],
      adminUserIds: [],
      settingsUpdatedAtMs: 102,
      maxNewMessagesPerScan: 1,
      attach,
    });

    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'admin-authored-post' }),
    );
  });

  it('leaves in-progress messages unadvanced so a later repair scan can retry them', async () => {
    const manager = createScanManager(() => 10_000);

    await manager.processListedMessages({
      chatId: 'channel-1',
      messages: [{ id: 'message-1', timestamp: 100, body: { text: 'Post' } }],
      adminUserIds: [],
      settingsUpdatedAtMs: 0,
      maxNewMessagesPerScan: 1,
      attach: async () => 'in_progress',
    });

    expect(manager.states.get('channel-1')).toEqual({
      latestTimestampMs: 0,
      latestMessageIdsAtTimestamp: [],
      idleStreak: 0,
      nextScanAtMs: 11_000,
    });
  });

  it('selects only the edit-capable bot that authored the channel post', async () => {
    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: ['bot-a', 'bot-b'],
        requiredAuthorUserId: '222000',
        resolveExecutableBotIdentity: (botId) => ({
          botId,
          contactId: botId === 'bot-b' ? '222000' : '111000',
        }),
      }),
    ).resolves.toEqual({ botId: 'bot-b', requiredAuthorVerified: true });
  });

  it('matches an executable bot handle without requiring a contact id', async () => {
    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: ['222000_bot'],
        requiredAuthorUserId: '222000',
        resolveExecutableBotIdentity: (botId) => ({ botId, contactId: null }),
      }),
    ).resolves.toEqual({ botId: '222000_bot', requiredAuthorVerified: true });
  });

  it('rejects a known fleet author that does not match the executable candidate', async () => {
    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: ['bot-a'],
        requiredAuthorUserId: '222000',
        resolveExecutableBotIdentity: (botId) => ({ botId, contactId: '111000' }),
      }),
    ).resolves.toEqual({ botId: null, requiredAuthorVerified: false });
  });

  it('rejects a handle-like action candidate that is not executable', async () => {
    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: ['222000_bot'],
        requiredAuthorUserId: '222000',
        resolveExecutableBotIdentity: () => null,
      }),
    ).resolves.toEqual({ botId: null, requiredAuthorVerified: false });
  });

  it('rejects an executable identity returned for a different fallback bot', async () => {
    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: ['stale-bot'],
        requiredAuthorUserId: '222000',
        resolveExecutableBotIdentity: () => ({
          botId: 'entry-bot',
          contactId: '222000',
        }),
      }),
    ).resolves.toEqual({ botId: null, requiredAuthorVerified: false });
  });

  it('rejects an implicit null action route without resolving an identity', async () => {
    const resolveExecutableBotIdentity = jest.fn();

    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: [null],
        requiredAuthorUserId: '222000',
        resolveExecutableBotIdentity,
      }),
    ).resolves.toEqual({ botId: null, requiredAuthorVerified: false });
    expect(resolveExecutableBotIdentity).not.toHaveBeenCalled();
  });

  it('rejects a known runtime author when the action route has no candidates', async () => {
    const resolveExecutableBotIdentity = jest.fn();

    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: [],
        requiredAuthorUserId: '222000',
        resolveExecutableBotIdentity,
      }),
    ).resolves.toEqual({ botId: null, requiredAuthorVerified: false });
    expect(resolveExecutableBotIdentity).not.toHaveBeenCalled();
  });

  it('selects an explicit executable delete route when no author match is required', async () => {
    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: ['delete-bot'],
        resolveExecutableBotIdentity: (botId) => ({ botId, contactId: '900001' }),
      }),
    ).resolves.toEqual({ botId: 'delete-bot', requiredAuthorVerified: true });
  });

  it('rejects an empty delete route without falling back to another bot', async () => {
    await expect(
      resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: [],
        resolveExecutableBotIdentity: jest.fn(),
      }),
    ).resolves.toEqual({ botId: null, requiredAuthorVerified: false });
  });
});
