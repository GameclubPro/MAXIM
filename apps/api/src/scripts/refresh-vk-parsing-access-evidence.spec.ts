import { ChatBotMembershipStatus, ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import {
  readVkParsingAccessEvidenceRefreshOptions,
  runVkParsingAccessEvidenceRefresh,
  VK_PARSING_ACCESS_EVIDENCE_SOURCE,
} from './refresh-vk-parsing-access-evidence';

describe('refresh-vk-parsing-access-evidence script', () => {
  const fixedNow = new Date('2026-07-31T09:00:00.000Z');

  function membership(botId: string) {
    return {
      botId,
      status: ChatBotMembershipStatus.ACTIVE,
    };
  }

  function chat(id: string, entityType: ChatEntityType, botMemberships = [membership('bot-1')]) {
    return { id, entityType, botMemberships };
  }

  function createFixture(rows = [chat('chat-1', ChatEntityType.CHAT)]) {
    const prisma = {
      chat: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const registry = {
      getDiscoveryBots: jest
        .fn()
        .mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }, { id: 'bot-draining' }]),
      getActionableBots: jest
        .fn()
        .mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }, { id: 'bot-action-only' }]),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
    };
    const recordBotAccessProbe = jest.fn().mockResolvedValue(true);
    const botLink = { recordBotAccessProbe };
    return { prisma, registry, maxClient, botLink, recordBotAccessProbe };
  }

  it('requires one to five unique explicit chat IDs and defaults to dry-run', () => {
    expect(readVkParsingAccessEvidenceRefreshOptions(['--chat-id', 'chat-1', '--json'])).toEqual({
      apply: false,
      json: true,
      chatIds: ['chat-1'],
    });
    expect(
      readVkParsingAccessEvidenceRefreshOptions([
        '--apply',
        '--chat-id',
        'chat-1',
        '--chat-id',
        'chat-2',
      ]),
    ).toEqual({ apply: true, json: false, chatIds: ['chat-1', 'chat-2'] });
    expect(() => readVkParsingAccessEvidenceRefreshOptions([])).toThrow(
      'At least one explicit --chat-id is required',
    );
    expect(() =>
      readVkParsingAccessEvidenceRefreshOptions(['--chat-id', 'chat-1', '--chat-id', 'chat-1']),
    ).toThrow('Each --chat-id must be unique');
    expect(() =>
      readVkParsingAccessEvidenceRefreshOptions(
        Array.from({ length: 6 }, (_, index) => ['--chat-id', `chat-${index}`]).flat(),
      ),
    ).toThrow('At most 5 --chat-id values are allowed');
    expect(() =>
      readVkParsingAccessEvidenceRefreshOptions(['--apply', '--dry-run', '--chat-id', 'chat-1']),
    ).toThrow('--apply cannot be combined with --dry-run');
    expect(() =>
      readVkParsingAccessEvidenceRefreshOptions(['--chat-id', 'chat-1', '--all']),
    ).toThrow('Unknown option: --all');
  });

  it('loads only named managed chats and eligible active configured bots in a dry-run', async () => {
    const fixture = createFixture([
      chat('chat-1', ChatEntityType.CHAT, [
        membership('bot-1'),
        membership('bot-draining'),
        membership('bot-action-only'),
        membership('bot-unconfigured'),
      ]),
      chat('hidden-chat', ChatEntityType.CHAT, [membership('bot-2')]),
    ]);

    const summary = await runVkParsingAccessEvidenceRefresh(
      fixture.prisma as never,
      fixture.registry as never,
      fixture.maxClient,
      fixture.botLink,
      { apply: false, json: false, chatIds: ['chat-1'] },
      () => fixedNow,
    );

    expect(fixture.prisma.chat.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['chat-1'] },
        OR: [
          { catalogKind: ChatCatalogKind.MANAGED },
          { catalogKind: ChatCatalogKind.UNKNOWN, entityType: ChatEntityType.CHANNEL },
        ],
      },
      select: expect.objectContaining({
        id: true,
        botMemberships: expect.objectContaining({
          where: { status: ChatBotMembershipStatus.ACTIVE },
        }),
      }),
      orderBy: { id: 'asc' },
      take: 1,
    });
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'background',
      sourceTag: 'vk_parsing',
      timeoutMs: 5_000,
    });
    expect(fixture.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(summary).toEqual(
      expect.objectContaining({
        apply: false,
        requested: 1,
        selected: 1,
        ready: 1,
        wouldPersist: 1,
        complete: true,
      }),
    );
    expect(summary.outcomes[0]).toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        result: 'ready',
        eligibleBotIds: ['bot-1'],
        freshCapableBotIds: ['bot-1'],
      }),
    );
  });

  it('persists a successful chat-admin probe through MaxBotLinkService', async () => {
    const fixture = createFixture();

    const summary = await runVkParsingAccessEvidenceRefresh(
      fixture.prisma as never,
      fixture.registry as never,
      fixture.maxClient,
      fixture.botLink,
      { apply: true, json: false, chatIds: ['chat-1'] },
      () => fixedNow,
    );

    expect(fixture.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(fixture.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      access: {
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      },
      source: VK_PARSING_ACCESS_EVIDENCE_SOURCE,
      checkedAt: fixedNow,
      allowMembershipRecovery: false,
    });
    expect(summary).toEqual(expect.objectContaining({ persisted: 1, ready: 1, complete: true }));
  });

  it('fails closed when the access boundary declines persistence', async () => {
    const fixture = createFixture();
    fixture.recordBotAccessProbe.mockResolvedValue(false);

    const summary = await runVkParsingAccessEvidenceRefresh(
      fixture.prisma as never,
      fixture.registry as never,
      fixture.maxClient,
      fixture.botLink,
      { apply: true, json: false, chatIds: ['chat-1'] },
      () => fixedNow,
    );

    expect(summary).toEqual(
      expect.objectContaining({ casConflicts: 1, persisted: 0, ready: 0, complete: false }),
    );
    expect(summary.outcomes[0]?.bots[0]).toEqual(
      expect.objectContaining({ result: 'cas_conflict', capable: true, persisted: false }),
    );
  });

  it('requires channel write permission before reporting fresh publish capability', async () => {
    const fixture = createFixture([
      chat('channel-1', ChatEntityType.CHANNEL, [membership('bot-1'), membership('bot-2')]),
    ]);
    fixture.maxClient.getCurrentChatMemberAccess
      .mockResolvedValueOnce({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_messages'],
      })
      .mockResolvedValueOnce({
        userId: 'bot-user-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['can-write'],
      });

    const summary = await runVkParsingAccessEvidenceRefresh(
      fixture.prisma as never,
      fixture.registry as never,
      fixture.maxClient,
      fixture.botLink,
      { apply: true, json: false, chatIds: ['channel-1'] },
      () => fixedNow,
    );

    expect(
      fixture.maxClient.getCurrentChatMemberAccess.mock.calls.map((call) => call[1].botId),
    ).toEqual(['bot-1', 'bot-2']);
    expect(fixture.recordBotAccessProbe).toHaveBeenCalledTimes(2);
    expect(summary.outcomes[0]?.bots.map((bot) => bot.capable)).toEqual([false, true]);
    expect(summary.outcomes[0]?.freshCapableBotIds).toEqual(['bot-2']);
    expect(summary.complete).toBe(true);
  });

  it('leaves transient failures untouched and fails only the chat without a fresh capable bot', async () => {
    const fixture = createFixture([
      chat('chat-1', ChatEntityType.CHAT, [membership('bot-1')]),
      chat('chat-2', ChatEntityType.CHAT, [membership('bot-2')]),
    ]);
    fixture.maxClient.getCurrentChatMemberAccess
      .mockResolvedValueOnce({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      })
      .mockRejectedValueOnce(new Error('MAX access lookup timeout'));

    const summary = await runVkParsingAccessEvidenceRefresh(
      fixture.prisma as never,
      fixture.registry as never,
      fixture.maxClient,
      fixture.botLink,
      { apply: true, json: false, chatIds: ['chat-1', 'chat-2'] },
      () => fixedNow,
    );

    expect(fixture.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(fixture.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', botId: 'bot-1' }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        requested: 2,
        selected: 2,
        ready: 1,
        persisted: 1,
        transientErrors: 1,
        complete: false,
      }),
    );
    expect(summary.outcomes[1]).toEqual(
      expect.objectContaining({ chatId: 'chat-2', result: 'access_unproven' }),
    );
    expect(summary.outcomes[1]?.bots[0]).toEqual(
      expect.objectContaining({ result: 'transient_error', persisted: false }),
    );
  });

  it('reports safely classified terminal access loss without persisting denial', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValue({
      response: { status: 403, data: { code: 'chat.denied', message: 'Forbidden' } },
    });

    const summary = await runVkParsingAccessEvidenceRefresh(
      fixture.prisma as never,
      fixture.registry as never,
      fixture.maxClient,
      fixture.botLink,
      { apply: true, json: false, chatIds: ['chat-1'] },
      () => fixedNow,
    );

    expect(fixture.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(summary).toEqual(
      expect.objectContaining({ terminalAccessLosses: 1, ready: 0, complete: false }),
    );
    expect(summary.outcomes[0]?.bots[0]).toEqual(
      expect.objectContaining({
        result: 'terminal_access_loss',
        terminalReason: 'bot_denied',
        persisted: false,
      }),
    );
  });

  it('runs live probes serially', async () => {
    const fixture = createFixture([
      chat('chat-1', ChatEntityType.CHAT, [membership('bot-1'), membership('bot-2')]),
    ]);
    let active = 0;
    let maxActive = 0;
    fixture.maxClient.getCurrentChatMemberAccess.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { userId: 'bot-user', isAdmin: true, isOwner: false, permissions: [] };
    });

    await runVkParsingAccessEvidenceRefresh(
      fixture.prisma as never,
      fixture.registry as never,
      fixture.maxClient,
      fixture.botLink,
      { apply: false, json: false, chatIds: ['chat-1'] },
      () => fixedNow,
    );

    expect(maxActive).toBe(1);
  });
});
