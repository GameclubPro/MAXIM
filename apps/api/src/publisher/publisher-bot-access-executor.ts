import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import type { MaxClientService } from '../max/max-client.service';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { publisherAccessProbeLifecycleWhere } from './publisher-access-probe-fence';
import type { PublisherBindingRefreshReason } from './publisher-binding-refresh.queue';
import type { PublisherAccessProbeOutcome } from './publisher-access-refresh-policy';
const PUBLISHER_ACCESS_SNAPSHOT_TTL_MS = 15 * 60_000;

export class PublisherBotAccessExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly publisherBotId: string,
  ) {}
  async execute(params: {
    chatId: string;
    reason: PublisherBindingRefreshReason;
    probeStartedAt: Date;
    materializeForwarded: boolean;
  }) {
    const botAccess = await this.maxClient.getCurrentChatMemberAccess(params.chatId, {
      botId: this.publisherBotId,
      trafficClass:
        params.reason === 'manual_recheck' || params.reason === 'policy_enablement_recheck'
          ? 'interactive'
          : 'background',
      sourceTag: 'publisher_readiness',
      bypassCache: true,
      timeoutMs: 5_000,
    });
    const checkedAt = new Date();
    const snapshot = buildBotAccessSnapshotPersistence(botAccess, {
      source: `publisher_refresh_${params.reason}`,
      now: checkedAt,
      ttlMs: PUBLISHER_ACCESS_SNAPSHOT_TTL_MS,
    });
    if (!params.materializeForwarded) {
      const committed = await this.prisma.publisherEntityBinding.updateMany({
        where: {
          chatId: params.chatId,
          publisherBotId: this.publisherBotId,
          status: ChatBotMembershipStatus.ACTIVE,
          AND: [
            publisherAccessProbeLifecycleWhere(params.probeStartedAt),
            {
              OR: [
                { botAccessCheckedAt: null },
                { botAccessCheckedAt: { lte: params.probeStartedAt } },
              ],
            },
          ],
        },
        data: {
          status: ChatBotMembershipStatus.ACTIVE,
          capabilities: botAccess.permissions,
          ...snapshot,
          lastSeenAt: checkedAt,
        },
      });
      if (committed.count === 0)
        return { outcome: 'superseded' as const, botAccess, snapshot, checkedAt };
    }
    return {
      outcome: (botAccess.isAdmin || botAccess.isOwner
        ? 'confirmed'
        : 'denied') as PublisherAccessProbeOutcome,
      botAccess,
      snapshot,
      checkedAt,
    };
  }
}
