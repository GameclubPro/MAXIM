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
    const prisma = {
      managedPoll: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(claimedPoll),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
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
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
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
      2,
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

    await expect(
      service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, { limit: '2' }),
    ).resolves.toMatchObject({
      items: [{ id: 'poll-3' }, { id: 'poll-2' }],
      nextCursor: 'poll-2',
    });
    expect(prisma.managedPoll.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    expect(prisma.managedPollVote.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: { in: ['poll-3', 'poll-2'] } } }),
    );
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
