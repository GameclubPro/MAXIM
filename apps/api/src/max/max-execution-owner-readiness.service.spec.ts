import { Logger } from '@nestjs/common';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import { buildBotAccessSnapshotPersistence } from './bot-access-snapshot.util';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxClientService } from './max-client.service';
import { MaxExecutionOwnerReadinessService } from './max-execution-owner-readiness.service';
import { executionRouteProof, type MaxExecutionOwnerState } from './max-execution-route-proof';

const NOW = new Date('2026-10-05T10:00:00.000Z');
const ADMIN = {
  isAdmin: true,
  isOwner: false,
  permissionsKnown: true,
  permissions: ['read_all_messages', 'write'],
};

function fixture(count: number) {
  const state: MaxExecutionOwnerState = {
    chatId: '-100',
    entityType: ChatEntityType.CHAT,
    primaryBotId: 'bot-00',
    routingVersion: 7,
    candidates: Array.from({ length: count }, (_, index) => ({
      botId: `bot-${String(index).padStart(2, '0')}`,
      status: ChatBotMembershipStatus.ACTIVE,
      ...buildBotAccessSnapshotPersistence(ADMIN, { source: 'seed', now: NOW }),
    })),
  };
  const links = {
    loadChatExecutionOwnerState: jest.fn(async () => state),
    getFreshChatBotExecutionProof: jest.fn(
      async (params: { botId: string; purpose?: Parameters<typeof executionRouteProof>[2] }) =>
        executionRouteProof(state, params.botId, params.purpose),
    ),
    recordBotAccessProbe: jest.fn(
      async (params: Parameters<MaxBotLinkService['recordBotAccessProbe']>[0]) => {
        const candidate = state.candidates.find((membership) => membership.botId === params.botId)!;
        Object.assign(
          candidate,
          buildBotAccessSnapshotPersistence(params.access, {
            source: params.source,
            now: params.checkedAt,
            channelReadVerified: params.channelReadVerified,
            lastErrorCode: params.lastErrorCode,
          }),
        );
        return true;
      },
    ),
    selectChatPrimaryBot: jest.fn(
      async (params: { botId: string; expectedRoutingVersion: number }) => {
        if (state.routingVersion !== params.expectedRoutingVersion) return false;
        state.primaryBotId = params.botId;
        state.routingVersion += 1;
        return true;
      },
    ),
  };
  const max = {
    getCurrentChatMemberAccess: jest.fn(async () => ADMIN),
    getChatSnapshot: jest.fn(async () => ({ chatId: state.chatId, entityType: 'channel' })),
  };
  const locks = {
    acquireLock: jest.fn(async () => 'probe-token'),
    renewLock: jest.fn(async () => true),
    releaseLock: jest.fn(async () => undefined),
  };
  const service = new MaxExecutionOwnerReadinessService(
    links as unknown as MaxBotLinkService,
    max as unknown as MaxClientService,
    locks as unknown as RedisCounterService,
  );
  return { state, links, max, locks, service };
}

describe('MaxExecutionOwnerReadinessService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reports bounded activation waits without probing dormant bots or retaining private identities', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture(1);
    Object.assign(
      f.state.candidates[0]!,
      buildBotAccessSnapshotPersistence(
        { isAdmin: false, isOwner: false, permissionsKnown: true },
        { source: 'denied', now: NOW },
      ),
    );
    for (let index = 0; index < 20; index += 1) {
      expect(await f.service.ensureReady({ chatId: '-100' })).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        reason: 'no_eligible_executor',
        purpose: 'moderation',
        coalescedObservations: 1,
        candidateCount: 1,
        activationRequiredCount: 1,
        capabilityDeniedCount: 0,
        proofMissingCount: 0,
        snapshotChangedCount: 0,
      },
      'Moderation executor readiness is waiting',
    );
    jest.advanceTimersByTime(30_000);
    expect(await f.service.ensureReady({ chatId: '-100' })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ coalescedObservations: 20 });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/-100|bot-00|permissionsSnapshot|denied/);
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
  });

  it('retains the original unavailable error and lease release when a diagnostic sink fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('log sink failed');
    });
    const f = fixture(1);
    const upstream = new Error('private upstream detail');
    f.max.getCurrentChatMemberAccess.mockRejectedValue(upstream);
    await expect(f.service.ensureReady({ chatId: '-100', force: true })).rejects.toMatchObject({
      name: 'WebhookExecutionOwnerUnavailableError',
      message: 'Current execution owner probe pending',
      retryAfterMs: 1000,
      cause: expect.objectContaining({ cause: upstream }),
    });
    expect(f.locks.releaseLock).toHaveBeenCalledTimes(1);
    expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
  });

  it('distinguishes probe contention and missing local state with finite diagnostics only', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture(1);
    f.locks.acquireLock.mockResolvedValue(null as never);
    await expect(f.service.ensureReady({ chatId: '-100', force: true })).rejects.toBeInstanceOf(
      WebhookExecutionOwnerUnavailableError,
    );
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reason: 'probe_busy' });
    f.links.loadChatExecutionOwnerState.mockResolvedValue(null as never);
    expect(await f.service.ensureReady({ chatId: '-100' })).toBeNull();
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ reason: 'chat_state_missing' });
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('keeps the assigned moderator when a caller prefers a healthy peer', async () => {
    const f = fixture(6);
    f.state.fixedModeratorBotId = 'bot-00';
    const proof = await f.service.ensureReady({
      chatId: '-100',
      preferredBotId: 'bot-05',
      purpose: 'send_message',
    });
    expect(proof?.botId).toBe('bot-00');
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
  });

  it('does not promote a healthy peer when the assigned moderator loses access', async () => {
    const f = fixture(6);
    f.state.fixedModeratorBotId = 'bot-00';
    Object.assign(
      f.state.candidates[0]!,
      buildBotAccessSnapshotPersistence(
        { isAdmin: false, isOwner: false, permissionsKnown: true },
        { source: 'denied', now: NOW },
      ),
    );
    expect(await f.service.ensureReady({ chatId: '-100' })).toBeNull();
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
    expect(f.state.fixedModeratorBotId).toBe('bot-00');
  });

  it.each([1, 4, 9, 12])('keeps one healthy shared owner with %i assigned bots', async (count) => {
    const f = fixture(count);
    const proof = await f.service.ensureReady({
      chatId: '-100',
      preferredBotId: f.state.candidates[count - 1]!.botId,
    });
    expect(proof?.botId).toBe('bot-00');
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
  });

  it.each([3, 6, 12])(
    'repairs a demoted primary using stable peers with %i assigned bots',
    async (count) => {
      const f = fixture(count);
      Object.assign(
        f.state.candidates[0]!,
        buildBotAccessSnapshotPersistence(
          { isAdmin: false, isOwner: false, permissionsKnown: true },
          { source: 'denied', now: NOW },
        ),
      );
      const proof = await f.service.ensureReady({
        chatId: '-100',
        preferredBotId: f.state.candidates[count - 1]!.botId,
      });
      expect(proof?.botId).toBe('bot-01');
      expect(f.links.selectChatPrimaryBot).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: 'bot-01',
          expectedRoutingVersion: 7,
          expectedPreviousOwner: {
            botId: 'bot-00',
            accessEpoch: { checkedAt: NOW, source: 'denied' },
            purpose: 'moderation',
          },
        }),
      );
    },
  );

  it.each([
    'moderation',
    'delete_message',
    'edit_message',
    'send_message',
    'moderate_member',
  ] as const)(
    'rejects fast-path %s for known baseline dormancy without probing',
    async (purpose) => {
      const f = fixture(1);
      f.state.candidates[0]!.permissionsSnapshot = {
        ...ADMIN,
        permissions: ['write', 'add_remove_members'],
      };
      expect(executionRouteProof(f.state, 'bot-00', purpose)).toBeNull();
      expect(await f.service.ensureReady({ chatId: '-100', purpose, force: true })).toBeNull();
      expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    },
  );

  it('never probes a known missing optional member capability and uses a healthy peer', async () => {
    const f = fixture(2);
    f.state.candidates[1]!.permissionsSnapshot = {
      ...ADMIN,
      permissions: [...ADMIN.permissions, 'add_remove_members'],
    };
    expect(
      (await f.service.ensureReady({ chatId: '-100', purpose: 'moderate_member', force: true }))
        ?.botId,
    ).toBe('bot-01');
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
  });

  it('refreshes missing permissions even when the incoming receiver is the stored primary', async () => {
    const f = fixture(4);
    f.state.candidates[0]!.permissionsSnapshot = {
      checkedAt: NOW.toISOString(),
      isAdmin: true,
      isOwner: false,
      permissions: [],
      permissionsKnown: false,
    };
    expect((await f.service.ensureReady({ chatId: '-100', preferredBotId: 'bot-00' }))?.botId).toBe(
      'bot-00',
    );
    expect(f.max.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ botId: 'bot-00', bypassCache: true }),
    );
  });

  it('does not turn a transient owner lookup into denial or peer promotion', async () => {
    const f = fixture(9);
    f.state.candidates[0]!.botAccessState = ChatBotAccessState.UNKNOWN;
    f.max.getCurrentChatMemberAccess.mockRejectedValueOnce({ response: { status: 429 } });
    await expect(f.service.ensureReady({ chatId: '-100' })).rejects.toBeInstanceOf(
      WebhookExecutionOwnerUnavailableError,
    );
    expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
    expect(f.locks.releaseLock).toHaveBeenCalledWith(expect.any(String), 'probe-token');
  });

  it.each([401, 403, 404])(
    'preserves a confirmed owner grant and assignment after an opaque own-member HTTP %s',
    async (status) => {
      const f = fixture(2);
      const original = structuredClone(f.state);
      f.max.getCurrentChatMemberAccess.mockRejectedValueOnce({
        response: { status, data: { message: 'chat not found; forbidden' } },
      });
      await expect(f.service.ensureReady({ chatId: '-100', force: true })).rejects.toBeInstanceOf(
        WebhookExecutionOwnerUnavailableError,
      );
      expect(f.state).toEqual(original);
      expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
      expect(f.locks.releaseLock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['access.denied', 'chat.denied', 'chat.not.found'])(
    'persists explicit own-member denial %s while retaining a fixed moderator',
    async (code) => {
      const f = fixture(2);
      f.state.fixedModeratorBotId = 'bot-00';
      f.max.getCurrentChatMemberAccess.mockRejectedValueOnce({
        response: { status: 404, data: { code } },
      });
      expect(await f.service.ensureReady({ chatId: '-100', force: true })).toBeNull();
      expect(f.state.candidates[0]).toMatchObject({
        botAccessState: ChatBotAccessState.DENIED,
        botAccessLastErrorCode: code,
      });
      expect(f.links.recordBotAccessProbe).toHaveBeenCalledWith(
        expect.objectContaining({ access: null, lastErrorCode: code }),
      );
      expect(f.state.fixedModeratorBotId).toBe('bot-00');
      expect(f.state.primaryBotId).toBe('bot-00');
      expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 401, code: undefined },
    { status: 403, code: undefined },
    { status: 404, code: undefined },
    { status: 403, code: 'access.denied' },
    { status: 403, code: 'chat.denied' },
    { status: 404, code: 'chat.not.found' },
  ])(
    'preserves channel membership when a separate exact channel read fails: %j',
    async ({ status, code }) => {
      const f = fixture(2);
      f.state.entityType = ChatEntityType.CHANNEL;
      f.state.candidates[0]!.permissionsSnapshot = {
        ...ADMIN,
        permissions: ['write', 'delete_message'],
      };
      f.max.getCurrentChatMemberAccess.mockResolvedValue({
        ...ADMIN,
        permissions: ['write', 'delete_message'],
      });
      f.max.getChatSnapshot.mockRejectedValueOnce({
        response: { status, data: { code, message: 'not accessible' } },
      });
      const original = structuredClone(f.state);
      await expect(f.service.ensureReady({ chatId: '-100' })).rejects.toBeInstanceOf(
        WebhookExecutionOwnerUnavailableError,
      );
      expect(f.max.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
      expect(f.max.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
      expect(f.state).toEqual(original);
    },
  );

  it('does not reinterpret a rejected positive persistence as a negative membership probe', async () => {
    const f = fixture(1);
    const original = structuredClone(f.state);
    f.links.recordBotAccessProbe.mockRejectedValueOnce({
      response: { status: 403, data: { code: 'chat.denied' } },
    });
    await expect(f.service.ensureReady({ chatId: '-100', force: true })).rejects.toBeInstanceOf(
      WebhookExecutionOwnerUnavailableError,
    );
    expect(f.links.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(f.links.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ access: ADMIN }),
    );
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
    expect(f.state).toEqual(original);
  });

  it('keeps an admin owner fenced when a successful lookup omits its permissions', async () => {
    const f = fixture(12);
    f.state.candidates[0]!.permissionsSnapshot = {
      ...ADMIN,
      permissionsKnown: false,
      permissions: [],
    };
    f.max.getCurrentChatMemberAccess.mockResolvedValueOnce({
      ...ADMIN,
      permissionsKnown: false,
      permissions: [],
    });
    await expect(f.service.ensureReady({ chatId: '-100' })).rejects.toBeInstanceOf(
      WebhookExecutionOwnerUnavailableError,
    );
    expect(f.state.primaryBotId).toBe('bot-00');
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
    expect(f.max.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.service.ensureReady({
          chatId: '-100',
          purpose: 'delete_message',
          preferredBotId: 'bot-01',
        })
      )?.botId,
    ).toBe('bot-01');
    expect(f.state.primaryBotId).toBe('bot-00');
  });

  it('keeps a known negative epoch dormant without probing after its recheck deadline', async () => {
    const f = fixture(1);
    Object.assign(
      f.state.candidates[0]!,
      buildBotAccessSnapshotPersistence(null, {
        source: 'denied',
        now: new Date(NOW.getTime() - 16_000),
      }),
    );
    expect(await f.service.ensureReady({ chatId: '-100' })).toBeNull();
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
  });

  it('uses a delete-capable peer without replacing the healthy read owner', async () => {
    const f = fixture(6);
    f.state.candidates[0]!.permissionsSnapshot = { ...ADMIN, permissions: ['read_all_messages'] };
    expect(
      (await f.service.ensureReady({ chatId: '-100', purpose: 'delete_message' }))?.botId,
    ).toBe('bot-01');
    expect(f.state.primaryBotId).toBe('bot-00');
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
  });

  it('rejects a changed route epoch instead of adopting a stale peer', async () => {
    const f = fixture(4);
    Object.assign(
      f.state.candidates[0]!,
      buildBotAccessSnapshotPersistence(
        { isAdmin: false, isOwner: false, permissionsKnown: true, permissions: [] },
        { source: 'denied', now: NOW },
      ),
    );
    f.links.selectChatPrimaryBot.mockResolvedValueOnce(false);
    await expect(f.service.ensureReady({ chatId: '-100' })).rejects.toBeInstanceOf(
      WebhookExecutionOwnerUnavailableError,
    );
  });

  it('records channel read evidence without adding a synthetic MAX permission', async () => {
    const f = fixture(1);
    f.state.entityType = ChatEntityType.CHANNEL;
    f.state.candidates[0]!.permissionsSnapshot = {
      ...ADMIN,
      permissions: ['write', 'delete_message'],
    };
    f.max.getCurrentChatMemberAccess.mockResolvedValue({
      ...ADMIN,
      permissions: ['write', 'delete_message'],
    });
    const proof = await f.service.ensureReady({ chatId: '-100' });
    expect(proof?.botId).toBe('bot-00');
    expect(f.max.getChatSnapshot).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ botId: 'bot-00', bypassCache: true }),
    );
    const snapshot = f.state.candidates[0]!.permissionsSnapshot as {
      permissions: string[];
      channelReadProof: { kind: string };
    };
    expect(snapshot.permissions).toEqual(['write', 'delete_message']);
    expect(snapshot.channelReadProof.kind).toBe('MAX_CHANNEL_GET');
  });

  it('does not choose member-only or permissionless administrators', async () => {
    const f = fixture(12);
    for (const candidate of f.state.candidates) {
      candidate.botAccessState = ChatBotAccessState.CONFIRMED_ADMIN;
      candidate.permissionsSnapshot = { ...ADMIN, permissions: [] };
    }
    expect(await f.service.ensureReady({ chatId: '-100' })).toBeNull();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
  });
});
