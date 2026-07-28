import { ChatBotMembershipStatus, ChatEntityType } from '../prisma/prisma-client';
import {
  readVkAccessLossRecoveryOptions,
  runVkAccessLossRecovery,
} from './recover-vk-parsing-access-loss';

describe('recover-vk-parsing-access-loss script', () => {
  const fixedNow = new Date('2026-07-28T08:30:00.000Z');

  function createSource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-1',
      chatId: 'channel-1',
      screenName: 'source_one',
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-06-01T09:00:00.000Z'),
      autoPublishPausedAt: new Date('2026-06-22T10:00:00.000Z'),
      autoPublishPausedReason: 'MAX access was lost',
      syncStatus: 'ERROR',
      nextSyncAt: null,
      syncStartedAt: new Date('2026-06-22T09:59:00.000Z'),
      syncLockedAt: null,
      syncLockedBy: null,
      syncLockDeadlineAt: null,
      syncHeartbeatAt: null,
      consecutiveFailures: 4,
      terminalFailureCount: 4,
      circuitOpenedAt: new Date('2026-06-22T10:00:00.000Z'),
      circuitReasonCode: 'max.access_lost',
      circuitReason: 'MAX access was lost',
      circuitRetryAt: null,
      lastErrorCode: 'max.access_lost',
      lastError: 'MAX access was lost',
      updatedAt: new Date('2026-06-22T10:00:00.000Z'),
      chat: { entityType: ChatEntityType.CHANNEL },
      ...overrides,
    };
  }

  function createFixture(sources = [createSource()]) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const transaction = jest.fn(async (callback) =>
      callback({
        vkParsingSource: { updateMany },
        auditLog: { create: auditCreate },
      }),
    );
    const prisma = {
      vkParsingSource: { findMany: jest.fn().mockResolvedValue(sources) },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            sendRouteQuarantinedUntil: null,
          },
        ]),
      },
      $transaction: transaction,
    };
    const maxBotLink = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
        routingVersion: 7,
      }),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '1001',
        isOwner: false,
        isAdmin: true,
        permissions: ['write'],
      }),
    };
    return {
      prisma,
      maxBotLink,
      maxClient,
      updateMany,
      auditCreate,
      transaction,
    };
  }

  it('defaults to a bounded dry-run and requires explicit unique IDs for apply', () => {
    expect(readVkAccessLossRecoveryOptions([])).toEqual({
      apply: false,
      json: false,
      sourceIds: [],
    });
    expect(
      readVkAccessLossRecoveryOptions([
        '--apply',
        '--source-id',
        'source-1',
        '--source-id',
        'source-2',
        '--json',
      ]),
    ).toEqual({
      apply: true,
      json: true,
      sourceIds: ['source-1', 'source-2'],
    });
    expect(() => readVkAccessLossRecoveryOptions(['--apply'])).toThrow(
      '--apply requires at least one explicit --source-id',
    );
    expect(() =>
      readVkAccessLossRecoveryOptions(['--source-id', 'source-1', '--source-id', 'source-1']),
    ).toThrow('Each --source-id must be unique');
    expect(() =>
      readVkAccessLossRecoveryOptions([
        '--source-id',
        '1',
        '--source-id',
        '2',
        '--source-id',
        '3',
        '--source-id',
        '4',
        '--source-id',
        '5',
        '--source-id',
        '6',
      ]),
    ).toThrow('At most 5 --source-id values are allowed');
  });

  it('selects only exact eligible IDs, reports unmatched IDs, and never mutates in dry-run', async () => {
    const fixture = createFixture();

    const summary = await runVkAccessLossRecovery(
      fixture.prisma as never,
      fixture.maxBotLink,
      fixture.maxClient,
      {
        apply: false,
        json: false,
        sourceIds: ['source-1', 'missing-source'],
      },
      () => fixedNow,
    );

    expect(fixture.prisma.vkParsingSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['source-1', 'missing-source'] },
          syncStatus: 'ERROR',
          lastErrorCode: 'max.access_lost',
          circuitReasonCode: 'max.access_lost',
        }),
        take: 5,
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        apply: false,
        requested: 2,
        selected: 1,
        unmatchedSourceIds: ['missing-source'],
        liveCapable: 1,
        applied: 0,
      }),
    );
    expect(summary.outcomes[0]).toEqual(
      expect.objectContaining({ result: 'would_apply', confirmedBotId: 'bot-1' }),
    );
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('channel-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'background',
      sourceTag: 'vk_parsing',
      timeoutMs: 5_000,
    });
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.updateMany).not.toHaveBeenCalled();
    expect(fixture.auditCreate).not.toHaveBeenCalled();
  });

  it('skips quarantined routes and probes remaining candidates until channel write is live', async () => {
    const fixture = createFixture();
    fixture.maxBotLink.resolveBotRoute.mockResolvedValue({
      purpose: 'send_message',
      chatId: 'channel-1',
      primaryBotId: 'bot-1',
      botId: 'bot-2',
      candidateBotIds: ['bot-1', 'bot-2', 'bot-3'],
      reason: 'alternate_confirmed',
      routingVersion: 8,
    });
    fixture.prisma.chatBotMembership.findMany.mockResolvedValue([
      {
        botId: 'bot-1',
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteQuarantinedUntil: new Date('2026-07-28T14:30:00.000Z'),
      },
      {
        botId: 'bot-2',
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteQuarantinedUntil: null,
      },
      {
        botId: 'bot-3',
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteQuarantinedUntil: null,
      },
    ]);
    fixture.maxClient.getCurrentChatMemberAccess
      .mockResolvedValueOnce({
        userId: '1002',
        isOwner: false,
        isAdmin: true,
        permissions: [],
      })
      .mockResolvedValueOnce({
        userId: '1003',
        isOwner: false,
        isAdmin: true,
        permissions: ['can_write'],
      });

    const summary = await runVkAccessLossRecovery(
      fixture.prisma as never,
      fixture.maxBotLink,
      fixture.maxClient,
      { apply: false, json: false, sourceIds: ['source-1'] },
      () => fixedNow,
    );

    expect(
      fixture.maxClient.getCurrentChatMemberAccess.mock.calls.map((call) => call[1].botId),
    ).toEqual(['bot-2', 'bot-3']);
    expect(summary.outcomes[0]).toEqual(
      expect.objectContaining({
        result: 'would_apply',
        confirmedBotId: 'bot-3',
        liveChecks: [
          { botId: 'bot-1', result: 'route_quarantined' },
          { botId: 'bot-2', result: 'insufficient_access' },
          { botId: 'bot-3', result: 'capable' },
        ],
      }),
    );
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('applies recovery with a full source CAS, a fresh baseline, and a durable audit', async () => {
    const source = createSource();
    const fixture = createFixture([source]);

    const summary = await runVkAccessLossRecovery(
      fixture.prisma as never,
      fixture.maxBotLink,
      fixture.maxClient,
      { apply: true, json: false, sourceIds: ['source-1'] },
      () => fixedNow,
    );

    expect(summary.outcomes[0]).toEqual(
      expect.objectContaining({
        result: 'applied',
        confirmedBotId: 'bot-1',
        previousAutoPublishEnabledAt: '2026-06-01T09:00:00.000Z',
        nextAutoPublishEnabledAt: fixedNow.toISOString(),
      }),
    );
    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'source-1',
        status: 'ACTIVE',
        importEnabled: true,
        autoPublishEnabled: true,
        autoPublishEnabledAt: source.autoPublishEnabledAt,
        autoPublishPausedAt: source.autoPublishPausedAt,
        syncStatus: 'ERROR',
        nextSyncAt: null,
        circuitOpenedAt: source.circuitOpenedAt,
        circuitReasonCode: 'max.access_lost',
        lastErrorCode: 'max.access_lost',
        updatedAt: source.updatedAt,
      }),
      data: {
        syncStatus: 'IDLE',
        nextSyncAt: fixedNow,
        syncStartedAt: null,
        syncLockedAt: null,
        syncLockedBy: null,
        syncLockDeadlineAt: null,
        syncHeartbeatAt: null,
        consecutiveFailures: 0,
        terminalFailureCount: 0,
        circuitOpenedAt: null,
        circuitReasonCode: null,
        circuitReason: null,
        circuitRetryAt: null,
        lastErrorCode: null,
        lastError: null,
        autoPublishEnabledAt: fixedNow,
        autoPublishPausedAt: null,
        autoPublishPausedReason: null,
      },
    });
    expect(fixture.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'system',
        action: 'VK_PARSING_RECOVER_ACCESS_LOSS',
        payload: expect.objectContaining({
          sourceId: 'source-1',
          applyAt: fixedNow.toISOString(),
          confirmedBotId: 'bot-1',
          routeReason: 'primary_confirmed',
          previousAutoPublishEnabledAt: '2026-06-01T09:00:00.000Z',
          nextAutoPublishEnabledAt: fixedNow.toISOString(),
        }),
      }),
    });
  });

  it('does not enable or unpause autopublish when recovering a disabled source', async () => {
    const fixture = createFixture([
      createSource({
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-06-20T10:00:00.000Z'),
        autoPublishPausedReason: 'manual',
      }),
    ]);

    const summary = await runVkAccessLossRecovery(
      fixture.prisma as never,
      fixture.maxBotLink,
      fixture.maxClient,
      { apply: true, json: false, sourceIds: ['source-1'] },
      () => fixedNow,
    );

    const data = fixture.updateMany.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.nextSyncAt).toEqual(fixedNow);
    expect(data).not.toHaveProperty('autoPublishEnabled');
    expect(data).not.toHaveProperty('autoPublishEnabledAt');
    expect(data).not.toHaveProperty('autoPublishPausedAt');
    expect(data).not.toHaveProperty('autoPublishPausedReason');
    expect(summary.outcomes[0]).toEqual(
      expect.objectContaining({
        result: 'applied',
        previousAutoPublishEnabledAt: null,
        nextAutoPublishEnabledAt: null,
      }),
    );
    expect(fixture.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          previousAutoPublishPausedReason: 'manual',
          nextAutoPublishPausedReason: 'manual',
        }),
      }),
    });
  });

  it('does not write an audit when the source CAS loses', async () => {
    const fixture = createFixture();
    fixture.updateMany.mockResolvedValue({ count: 0 });

    const summary = await runVkAccessLossRecovery(
      fixture.prisma as never,
      fixture.maxBotLink,
      fixture.maxClient,
      { apply: true, json: false, sourceIds: ['source-1'] },
      () => fixedNow,
    );

    expect(summary.casConflicts).toBe(1);
    expect(summary.outcomes[0]?.result).toBe('cas_conflict');
    expect(fixture.auditCreate).not.toHaveBeenCalled();
  });

  it('does not open a transaction when no route has live publish capability', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: '1001',
      isOwner: false,
      isAdmin: true,
      permissions: [],
    });

    const summary = await runVkAccessLossRecovery(
      fixture.prisma as never,
      fixture.maxBotLink,
      fixture.maxClient,
      { apply: true, json: false, sourceIds: ['source-1'] },
      () => fixedNow,
    );

    expect(summary.outcomes[0]?.result).toBe('no_live_publish_capability');
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.updateMany).not.toHaveBeenCalled();
    expect(fixture.auditCreate).not.toHaveBeenCalled();
  });
});
