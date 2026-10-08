import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import {
  buildBotAccessSnapshotPersistence,
  type BotAccessSnapshotInput,
} from './bot-access-snapshot.util';
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
      async (params: {
        botId: string;
        access: BotAccessSnapshotInput;
        source: string;
        checkedAt: Date;
        channelReadVerified?: boolean;
      }) => {
        const candidate = state.candidates.find((membership) => membership.botId === params.botId)!;
        Object.assign(
          candidate,
          buildBotAccessSnapshotPersistence(params.access, {
            source: params.source,
            now: params.checkedAt,
            channelReadVerified: params.channelReadVerified,
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
  afterEach(() => jest.useRealTimers());

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
    f.state.candidates[0]!.botAccessCheckedAt = new Date(NOW.getTime() - 6 * 60_000);
    f.max.getCurrentChatMemberAccess.mockRejectedValueOnce({ response: { status: 429 } });
    await expect(f.service.ensureReady({ chatId: '-100' })).rejects.toBeInstanceOf(
      WebhookExecutionOwnerUnavailableError,
    );
    expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(f.links.selectChatPrimaryBot).not.toHaveBeenCalled();
    expect(f.locks.releaseLock).toHaveBeenCalledWith(expect.any(String), 'probe-token');
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
