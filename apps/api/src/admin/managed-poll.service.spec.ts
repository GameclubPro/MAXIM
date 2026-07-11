import { createHmac } from 'node:crypto';
import { ManagedPollStatus, ManagedPollVisibility } from '../prisma/prisma-client';
import { ManagedPollService } from './managed-poll.service';

const POLL_IDENTITY_SALT = '12345678901234567890123456789012';
const VOTE_EVENT_HASH = createHmac('sha256', POLL_IDENTITY_SALT)
  .update('event:bot-1:update-1')
  .digest('hex');

function createService(
  options: {
    visibility?: ManagedPollVisibility;
    existingOptionId?: string | null;
    existingEvent?: boolean;
    lastEventAt?: Date | null;
    status?: ManagedPollStatus;
    lastRenderError?: string | null;
    lockedAt?: Date | null;
    lastError?: string | null;
    publicationMessageId?: string | null;
    publicationBotId?: string | null;
    lockToken?: string | null;
    renderRevision?: number;
    renderedRevision?: number;
  } = {},
) {
  const poll = {
    id: 'poll-1',
    chatId: 'channel-1',
    actorUserId: 'admin-1',
    question: 'Что выбираем?',
    status: options.status ?? ManagedPollStatus.ACTIVE,
    visibility: options.visibility ?? ManagedPollVisibility.ANONYMOUS,
    identitySalt: POLL_IDENTITY_SALT,
    renderRevision: options.renderRevision ?? 0,
    renderedRevision: options.renderedRevision ?? 0,
    publicationMessageId:
      options.publicationMessageId === undefined ? 'message-1' : options.publicationMessageId,
    publicationBotId: options.publicationBotId === undefined ? 'bot-1' : options.publicationBotId,
    publicationUrl: null,
    publishedAt: new Date(),
    closedAt: null,
    lockedAt: options.lockedAt ?? null,
    lockToken:
      options.lockToken === undefined
        ? options.lockedAt
          ? 'publication-lock'
          : null
        : options.lockToken,
    lastError: options.lastError ?? null,
    lastRenderError: options.lastRenderError ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
    options: [
      {
        id: 'option-1',
        pollId: 'poll-1',
        position: 0,
        text: 'Первый',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'option-2',
        pollId: 'poll-1',
        position: 1,
        text: 'Второй',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
    managedPoll: {
      findUnique: jest.fn().mockResolvedValue(poll),
      update: jest.fn().mockResolvedValue(poll),
    },
    managedPollVoter: {
      findUnique: jest.fn().mockResolvedValue(
        options.existingOptionId
          ? {
              id: 'voter-1',
              lastEventAt: options.lastEventAt ?? null,
              recentEventHashes: options.existingEvent ? [VOTE_EVENT_HASH] : [],
              vote: { optionId: options.existingOptionId },
            }
          : null,
      ),
      update: jest.fn().mockResolvedValue({ id: 'voter-1' }),
      upsert: jest.fn().mockResolvedValue({ id: 'voter-1' }),
    },
    managedPollVote: {
      upsert: jest.fn().mockResolvedValue({ id: 'vote-1' }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const service = new ManagedPollService(prisma as never, {} as never, {} as never, {} as never);
  return { service, tx };
}

const voteParams = {
  pollId: 'poll-1',
  optionId: 'option-1',
  chatId: 'channel-1',
  messageId: 'message-1',
  callbackBotId: 'bot-1',
  eventId: 'bot-1:update-1',
  eventAt: new Date('2026-07-10T10:00:00.000Z'),
  voter: {
    userId: 'user-42',
    displayName: 'Анна Иванова',
    username: 'anna',
  },
};

describe('ManagedPollService vote persistence', () => {
  it('stores only a keyed identity for anonymous poll votes', async () => {
    const { service, tx } = createService();

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    const create = tx.managedPollVoter.upsert.mock.calls[0]?.[0]?.create;
    expect(create).toEqual(
      expect.objectContaining({
        pollId: 'poll-1',
        userId: null,
        displayName: null,
        username: null,
      }),
    );
    expect(create.identityHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(create.identityHash).not.toContain(voteParams.voter.userId);
  });

  it('stores display identity for open poll votes', async () => {
    const { service, tx } = createService({ visibility: ManagedPollVisibility.OPEN });

    await (service as any).recordVote(voteParams);
    expect(tx.managedPollVoter.upsert.mock.calls[0]?.[0]?.create).toEqual(
      expect.objectContaining({
        userId: 'user-42',
        displayName: 'Анна Иванова',
        username: 'anna',
      }),
    );
  });

  it('does not increment the render revision for the same selected option', async () => {
    const { service, tx } = createService({ existingOptionId: 'option-1' });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: false,
      pollId: 'poll-1',
      needsRender: false,
    });
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastEventAt: voteParams.eventAt,
          recentEventHashes: [VOTE_EVENT_HASH],
        }),
      }),
    );
    expect(tx.managedPollVote.upsert).not.toHaveBeenCalled();
  });

  it('does not replay an already committed callback over a newer vote', async () => {
    const { service, tx } = createService({
      existingOptionId: 'option-2',
      existingEvent: true,
      lastEventAt: new Date('2026-07-10T10:01:00.000Z'),
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: false,
      replayed: true,
      pollId: 'poll-1',
      needsRender: false,
    });
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVote.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.update).not.toHaveBeenCalled();
  });

  it('records but ignores a callback older than the latest voter event', async () => {
    const { service, tx } = createService({
      existingOptionId: 'option-2',
      lastEventAt: new Date('2026-07-10T10:01:00.000Z'),
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: false,
      replayed: true,
      pollId: 'poll-1',
      needsRender: false,
    });
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVote.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.update).toHaveBeenCalledWith({
      where: { id: 'voter-1' },
      data: {
        recentEventHashes: [VOTE_EVENT_HASH],
      },
    });
  });

  it('marks a closed poll for render repair only when the last render failed', async () => {
    const { service } = createService({
      status: ManagedPollStatus.CLOSED,
      lastRenderError: 'edit failed',
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'closed',
      pollId: 'poll-1',
      needsRender: true,
    });
  });

  it('marks a closed poll for repair when its rendered revision is stale', async () => {
    const { service } = createService({
      status: ManagedPollStatus.CLOSED,
      renderRevision: 3,
      renderedRevision: 2,
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'closed',
      pollId: 'poll-1',
      needsRender: true,
    });
  });

  it('recovers a claimed publication from a callback before the sender settles', async () => {
    const { service, tx } = createService({
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      lastError: null,
      publicationMessageId: null,
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    expect(tx.managedPoll.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'poll-1' },
        data: expect.objectContaining({
          status: ManagedPollStatus.ACTIVE,
          publicationMessageId: 'message-1',
          lockedAt: null,
          lockToken: null,
          lastError: null,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RECOVER_CHANNEL_POLL_PUBLICATION' }),
      }),
    );
  });

  it('does not promote a draft that has no publication claim token', async () => {
    const { service, tx } = createService({
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      lockToken: null,
      lastError: 'Публикация требует ручной проверки.',
      publicationMessageId: null,
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({ kind: 'stale' });
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
  });

  it('rejects a callback delivered to a different bot', async () => {
    const { service, tx } = createService();

    await expect(
      (service as any).recordVote({ ...voteParams, callbackBotId: 'bot-2' }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
  });
});

describe('ManagedPollService image callback rendering', () => {
  it('acknowledges an image poll callback and uses the direct renderer', async () => {
    const maxClient = { answerCallback: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      publicationBotId: 'bot-1',
      renderRevision: 1,
      imageCount: 1,
      images: [],
    });
    const render = jest.spyOn(service as any, 'renderPollPublication').mockResolvedValue(true);

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'channel-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Голос учтён',
      undefined,
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(render).toHaveBeenCalledWith('channel-1', 'poll-1', 'vote-media');
  });

  it('keeps raw poll images out of callback rendering reads', async () => {
    const now = new Date();
    const findFirst = jest.fn().mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Вопрос',
      questionFormat: 'plain',
      imageCount: 1,
      status: ManagedPollStatus.ACTIVE,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 1,
      renderedRevision: 0,
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      publicationUrl: null,
      publishedAt: now,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Да' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Нет' },
      ],
    });
    const service = new ManagedPollService(
      {
        managedPoll: { findFirst },
        managedPollVote: { groupBy: jest.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (service as any).loadPollAggregate('channel-1', 'poll-1');

    const select = findFirst.mock.calls[0]?.[0]?.select;
    expect(select).toEqual(expect.objectContaining({ imageCount: true }));
    expect(select).not.toHaveProperty('images');
  });
});

describe('ManagedPollService draft editing', () => {
  it('preserves rich content when an older client omits new update fields', async () => {
    const now = new Date();
    const images = [
      {
        base64: Buffer.from('draft-image').toString('base64'),
        mimeType: 'image/jpeg',
        fileName: 'draft.jpg',
      },
    ];
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: '**Старый вопрос**',
      questionFormat: 'markdown',
      imageCount: 1,
      images,
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: POLL_IDENTITY_SALT,
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        {
          id: 'option-1',
          pollId: 'poll-1',
          position: 0,
          text: 'Да',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'option-2',
          pollId: 'poll-1',
          position: 1,
          text: 'Нет',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn().mockResolvedValue(poll),
        findUniqueOrThrow: jest.fn().mockResolvedValue(poll),
      },
      managedPollOption: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const service = new ManagedPollService(
      {
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as never,
      {} as never,
      { assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined) } as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.updateChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never, {
      question: 'Новый вопрос',
      visibility: 'ANONYMOUS',
      options: [
        { id: 'option-1', text: 'Да' },
        { id: 'option-2', text: 'Нет' },
      ],
    });

    expect(tx.managedPoll.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questionFormat: 'markdown',
          imageCount: 1,
          images,
        }),
      }),
    );
  });
});

describe('ManagedPollService render serialization', () => {
  it('defers rendering instead of using an unsafe local lock when Redis fails', async () => {
    const redisCounter = {
      acquireLock: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      releaseLock: jest.fn(),
    };
    const service = new ManagedPollService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      redisCounter as never,
    );
    const operation = jest.fn().mockResolvedValue(undefined);

    await expect((service as any).runPollRenderSerialized('poll-1', operation)).resolves.toBe(
      false,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(redisCounter.releaseLock).not.toHaveBeenCalled();
  });

  it('defers rendering when the distributed lock stays busy', async () => {
    jest.useFakeTimers();
    try {
      const redisCounter = {
        acquireLock: jest.fn().mockResolvedValue(null),
        releaseLock: jest.fn(),
      };
      const service = new ManagedPollService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        redisCounter as never,
      );
      const operation = jest.fn().mockResolvedValue(undefined);

      const result = (service as any).runPollRenderSerialized('poll-1', operation);
      await jest.advanceTimersByTimeAsync(4_100);

      await expect(result).resolves.toBe(false);
      expect(redisCounter.acquireLock).toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(redisCounter.releaseLock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases the distributed lock when rendering fails', async () => {
    const redisCounter = {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedPollService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      redisCounter as never,
    );
    const operation = jest.fn().mockRejectedValue(new Error('render failed'));

    await expect((service as any).runPollRenderSerialized('poll-1', operation)).rejects.toThrow(
      'render failed',
    );
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(
      'managed-poll:render:v1:poll-1',
      'lock-token',
    );
  });

  it('renews the distributed lock while a render is still running', async () => {
    jest.useFakeTimers();
    try {
      let finishOperation: () => void = () => undefined;
      const redisCounter = {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        renewLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      };
      const service = new ManagedPollService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        redisCounter as never,
      );
      const operation = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishOperation = resolve;
          }),
      );

      const result = (service as any).runPollRenderSerialized('poll-1', operation);
      await jest.advanceTimersByTimeAsync(30_000);

      expect(redisCounter.renewLock).toHaveBeenCalledWith(
        'managed-poll:render:v1:poll-1',
        'lock-token',
        120_000,
      );
      finishOperation();
      await expect(result).resolves.toBe(true);
      expect(redisCounter.releaseLock).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a coalesced repair when MAX rendering reports failure', async () => {
    jest.useFakeTimers();
    try {
      const service = new ManagedPollService({} as never, {} as never, {} as never, {} as never);
      jest
        .spyOn(service as any, 'runPollRenderSerialized')
        .mockImplementation(async (...args: unknown[]) => {
          const operation = args[1] as () => Promise<unknown>;
          await operation();
          return true;
        });
      const render = jest
        .spyOn(service as any, 'renderPollPublication')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      (service as any).schedulePollRenderRepair('channel-1', 'poll-1');
      const repair = (service as any).scheduledRenderRepairs.get('poll-1');
      await jest.runAllTimersAsync();
      await repair;

      expect(render).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ManagedPollService publication', () => {
  it('reloads the claimed draft before sending it to MAX', async () => {
    const basePoll = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Старый вопрос',
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'old-1', pollId: 'poll-1', position: 0, text: 'Старый 1' },
        { id: 'old-2', pollId: 'poll-1', position: 1, text: 'Старый 2' },
      ],
    };
    const claimedPoll = {
      ...basePoll,
      question: 'Новый вопрос',
      options: [
        { id: 'new-1', pollId: 'poll-1', position: 0, text: 'Новый 1' },
        { id: 'new-2', pollId: 'poll-1', position: 1, text: 'Новый 2' },
      ],
    };
    const managedPoll = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(claimedPoll),
    };
    const auditLog = { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const prisma = {
      managedPoll,
      auditLog,
      $transaction: jest.fn(
        async (
          callback: (client: {
            managedPoll: typeof managedPoll;
            auditLog: typeof auditLog;
          }) => unknown,
        ) => callback({ managedPoll, auditLog }),
      ),
    };
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        url: 'https://max.ru/channel/message-1',
      }),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChannelPollBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      chatContextCache as never,
    );
    jest
      .spyOn(service as any, 'findPoll')
      .mockResolvedValueOnce(basePoll)
      .mockResolvedValueOnce(claimedPoll);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      expect.stringContaining('Новый вопрос'),
      expect.objectContaining({
        buttons: expect.arrayContaining([
          [expect.objectContaining({ payload: 'poll|v2|poll-1|new-1' })],
        ]),
      }),
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[1]).not.toContain(
      'Старый вопрос',
    );
    expect(managedPoll.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'poll-1',
          lockToken: expect.any(String),
          status: ManagedPollStatus.DRAFT,
        }),
      }),
    );
  });

  it('uploads poll images and publishes a Markdown question as HTML', async () => {
    const draft = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: '**Новый вопрос**',
      questionFormat: 'markdown',
      imageCount: 1,
      images: [
        {
          base64: `data:image/jpeg;base64,${Buffer.from('poll-image').toString('base64')}`,
          mimeType: 'image/jpeg',
          fileName: 'poll.jpg',
        },
      ],
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Второй' },
      ],
    };
    const managedPoll = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(draft),
    };
    const auditLog = { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const prisma = {
      managedPoll,
      auditLog,
      $transaction: jest.fn(
        async (
          callback: (client: {
            managedPoll: typeof managedPoll;
            auditLog: typeof auditLog;
          }) => unknown,
        ) => callback({ managedPoll, auditLog }),
      ),
    };
    const maxClient = {
      uploadImage: jest.fn().mockResolvedValue({ token: 'poll-image-token' }),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChannelPollBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const prepared = await request.prepareAttempt({ botId: 'bot-2', job: {} });
        request.onDispatchAttempt({ botId: 'bot-2', job: { options: prepared.options } });
        expect(prepared.options).toEqual(
          expect.objectContaining({
            textFormat: 'html',
            imagePayload: { token: 'poll-image-token' },
          }),
        );
        return {
          messageId: 'message-1',
          url: 'https://max.ru/channel/message-1',
          botId: 'bot-2',
          candidateBotIds: ['bot-1', 'bot-2'],
          routingVersion: 4,
        };
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    jest.spyOn(service as any, 'findPoll').mockResolvedValue(draft);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never);

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from('poll-image'),
      'poll.jpg',
      'image/jpeg',
      expect.objectContaining({
        botId: 'bot-2',
        sourceTag: 'managed_poll',
      }),
    );
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-1:revision:0',
        routePurpose: 'channel_poll',
        text: expect.stringContaining('<strong>Новый вопрос</strong>'),
      }),
    );
    expect(adminService.resolveChannelPollBotId).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(managedPoll.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ images: [], publicationBotId: 'bot-2' }),
      }),
    );
  });

  it('builds gallery attachments from multiple uploaded poll images', async () => {
    const maxClient = {
      uploadImage: jest
        .fn()
        .mockResolvedValueOnce({ token: 'first-image' })
        .mockResolvedValueOnce({ token: 'second-image' }),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );

    await expect(
      (service as any).resolvePollPublicationMedia(
        [
          {
            base64: Buffer.from('first').toString('base64'),
            mimeType: 'image/png',
            fileName: 'first.png',
          },
          {
            base64: Buffer.from('second').toString('base64'),
            mimeType: 'image/webp',
            fileName: 'second.webp',
          },
        ],
        'bot-1',
      ),
    ).resolves.toEqual({
      attachments: [
        { type: 'image', payload: { token: 'first-image' } },
        { type: 'image', payload: { token: 'second-image' } },
      ],
    });
  });

  it('renews a publication claim while media is being prepared', async () => {
    jest.useFakeTimers();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new ManagedPollService(
      { managedPoll: { updateMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    try {
      const claim = (service as any).startPublicationClaimHeartbeat('poll-1', 'claim-1');

      await jest.advanceTimersByTimeAsync(15_000);

      await expect(claim.stop()).resolves.toBe(true);
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'poll-1',
          lockToken: 'claim-1',
          status: ManagedPollStatus.DRAFT,
        },
        data: { lockedAt: expect.any(Date) },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed when a publication claim cannot be renewed', async () => {
    const service = new ManagedPollService(
      {
        managedPoll: {
          updateMany: jest.fn().mockRejectedValue(new Error('database unavailable')),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const claim = (service as any).startPublicationClaimHeartbeat('poll-1', 'claim-1');

    await expect(claim.renew()).resolves.toBe(false);
    await expect(claim.stop()).resolves.toBe(false);
  });

  it('retries a deterministic attachment-not-ready rejection after image upload', async () => {
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValueOnce({
          response: { status: 400, data: { code: 'attachment.not.ready' } },
        })
        .mockResolvedValueOnce({ messageId: 'message-1', url: null }),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);

    await expect(
      (service as any).sendPollPublicationWithRetry(
        'channel-1',
        'poll-1',
        0,
        'Опрос',
        { imagePayload: { token: 'poll-image-token' } },
        [],
        'bot-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({ messageId: 'message-1', url: null, botId: 'bot-1' }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous media publication failure', async () => {
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValue({ response: { status: 504, data: { message: 'gateway timeout' } } }),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);

    await expect(
      (service as any).sendPollPublicationWithRetry(
        'channel-1',
        'poll-1',
        0,
        'Опрос',
        { imagePayload: { token: 'poll-image-token' } },
        [],
        'bot-1',
      ),
    ).rejects.toMatchObject({ response: { status: 504 } });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
  });

  it('fails closed in production when routed publication wiring is missing', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );

    try {
      await expect(
        (service as any).sendPollPublicationWithRetry(
          'channel-1',
          'poll-1',
          0,
          'Опрос',
          {},
          [],
          'bot-1',
        ),
      ).rejects.toThrow('Routed MAX publication service is required for production managed polls');
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('keeps an ambiguous publication claimed until the channel is checked', async () => {
    const draft = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Что выбираем?',
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Второй' },
      ],
    };
    const prisma = {
      managedPoll: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValue({ response: { status: 504, data: { message: 'gateway timeout' } } }),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChannelPollBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const accessLoss = { recordIfManagedEntityAccessLost: jest.fn() };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      {} as never,
      accessLoss as never,
    );
    jest.spyOn(service as any, 'findPoll').mockResolvedValue(draft);

    await expect(
      service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never),
    ).rejects.toThrow('MAX мог принять публикацию. Проверьте канал перед повтором.');

    expect(prisma.managedPoll.updateMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({ id: 'poll-1', lockToken: expect.any(String) }),
        data: { lastError: 'Публикация требует ручной проверки.' },
      }),
    );
    expect(accessLoss.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('releases the claim when draft reload fails before sending', async () => {
    const draft = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Что выбираем?',
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Второй' },
      ],
    };
    const prisma = {
      managedPoll: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    };
    const maxClient = { sendMessageImmediateWithResolvedLink: jest.fn() };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChannelPollBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const accessLoss = { recordIfManagedEntityAccessLost: jest.fn() };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      {} as never,
      accessLoss as never,
    );
    jest
      .spyOn(service as any, 'findPoll')
      .mockResolvedValueOnce(draft)
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never),
    ).rejects.toThrow('database unavailable');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.managedPoll.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          lockedAt: null,
          lockToken: null,
          publicationBotId: null,
        }),
      }),
    );
    expect(accessLoss.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });
});

describe('ManagedPollService lifecycle', () => {
  it('closes an active poll and renders the final state', async () => {
    const poll = { id: 'poll-1', chatId: 'channel-1', status: ManagedPollStatus.ACTIVE };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn().mockResolvedValue(poll),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      chatContextCache as never,
    );
    const render = jest.spyOn(service as any, 'renderPollPublication').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.closeChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never);

    expect(tx.managedPoll.update).toHaveBeenCalledWith({
      where: { id: 'poll-1' },
      data: {
        status: ManagedPollStatus.CLOSED,
        closedAt: expect.any(Date),
        renderRevision: { increment: 1 },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'CLOSE_CHANNEL_POLL' }),
      }),
    );
    expect(render).toHaveBeenCalledWith('channel-1', 'poll-1', 'close');
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
  });

  it('unlocks only an ambiguous draft publication', async () => {
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      lastError: 'Публикация требует ручной проверки.',
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn().mockResolvedValue(poll),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      chatContextCache as never,
    );
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.resetChannelPollPublication('channel-1', 'poll-1', {
      userId: 'admin-1',
    } as never);

    expect(tx.managedPoll.update).toHaveBeenCalledWith({
      where: { id: 'poll-1' },
      data: {
        lockedAt: null,
        lockToken: null,
        publicationBotId: null,
        lastError: null,
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RESET_CHANNEL_POLL_PUBLICATION' }),
      }),
    );
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
  });

  it('allows an expired publication claim to be reset after checking the channel', async () => {
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(Date.now() - 61_000),
      lastError: null,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn().mockResolvedValue(poll),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      chatContextCache as never,
    );
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.resetChannelPollPublication('channel-1', 'poll-1', {
      userId: 'admin-1',
    } as never);

    expect(tx.managedPoll.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lockedAt: null, lockToken: null, lastError: null }),
      }),
    );
  });
});

describe('ManagedPollService admin reads', () => {
  it('paginates poll history before aggregating votes', async () => {
    const now = new Date();
    const createPoll = (id: string) => ({
      id,
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: `Вопрос ${id}`,
      questionFormat: 'markdown',
      imageCount: 1,
      images: [
        {
          base64: Buffer.from(`image-${id}`).toString('base64'),
          mimeType: 'image/jpeg',
          fileName: `${id}.jpg`,
        },
      ],
      status: ManagedPollStatus.CLOSED,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 1,
      renderedRevision: 1,
      publicationMessageId: `message-${id}`,
      publicationBotId: 'bot-1',
      publicationUrl: null,
      publishedAt: now,
      closedAt: now,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        { id: `${id}-1`, pollId: id, position: 0, text: 'Да', createdAt: now, updatedAt: now },
        { id: `${id}-2`, pollId: id, position: 1, text: 'Нет', createdAt: now, updatedAt: now },
      ],
    });
    const polls = [createPoll('poll-3'), createPoll('poll-2'), createPoll('poll-1')];
    const prisma = {
      managedPoll: { findMany: jest.fn().mockResolvedValue(polls) },
      managedPollVote: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const adminService = { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      {} as never,
    );

    const response = await service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
      limit: '2',
    });

    expect(response).toMatchObject({
      items: [{ id: 'poll-3' }, { id: 'poll-2' }],
      nextCursor: 'poll-2',
    });
    expect(response.items[0]).toEqual(
      expect.objectContaining({ questionFormat: 'markdown', imageCount: 1 }),
    );
    expect(response.items[0]).not.toHaveProperty('images');
    expect(prisma.managedPoll.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        select: expect.objectContaining({ imageCount: true }),
      }),
    );
    expect(prisma.managedPoll.findMany.mock.calls[0]?.[0]?.select).not.toHaveProperty('images');
    expect(prisma.managedPollVote.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: { in: ['poll-3', 'poll-2'] } } }),
    );
  });

  it('returns saved images only from poll details', async () => {
    const now = new Date();
    const images = [
      {
        base64: Buffer.from('detail-image').toString('base64'),
        mimeType: 'image/png',
        fileName: 'detail.png',
      },
    ];
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Вопрос',
      questionFormat: 'markdown',
      imageCount: 1,
      images,
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        {
          id: 'option-1',
          pollId: 'poll-1',
          position: 0,
          text: 'Да',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'option-2',
          pollId: 'poll-1',
          position: 1,
          text: 'Нет',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const prisma = {
      managedPoll: { findFirst: jest.fn().mockResolvedValue(poll) },
      managedPollVote: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );

    await expect(
      service.getChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never),
    ).resolves.toMatchObject({
      questionFormat: 'markdown',
      imageCount: 1,
      images,
    });
  });

  it('does not expose voters for an anonymous poll', async () => {
    const prisma = {
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'poll-1',
          visibility: ManagedPollVisibility.ANONYMOUS,
        }),
      },
      managedPollVoter: { findMany: jest.fn() },
    };
    const adminService = { assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      {} as never,
    );

    await expect(
      service.getChannelPollVoters('channel-1', 'poll-1', { userId: 'admin-1' } as never, {}),
    ).rejects.toThrow('В анонимном опросе список участников скрыт.');
    expect(prisma.managedPollVoter.findMany).not.toHaveBeenCalled();
  });
});
