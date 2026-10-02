import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import type { MaxClientService } from '../max/max-client.service';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { publisherAccessProbeLifecycleWhere } from './publisher-access-probe-fence';
import type { PublisherBindingRefreshReason } from './publisher-binding-refresh.queue';
import type { PublisherAccessProbeOutcome } from './publisher-access-refresh-policy';
import type {
  PublisherAccessRefreshEvidenceService,
  PublisherRefreshProof,
} from './publisher-access-refresh-evidence.service';
const PUBLISHER_ACCESS_SNAPSHOT_TTL_MS = 15 * 60_000;

export class PublisherBotAccessExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly publisherBotId: string,
    private readonly evidence?: PublisherAccessRefreshEvidenceService,
  ) {}
  async execute(params: {
    chatId: string;
    reason: PublisherBindingRefreshReason;
    probeStartedAt: Date;
    materializeForwarded: boolean;
    previous?: PublisherRefreshProof;
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
    let committedAt: Date | null = null;
    if (!params.materializeForwarded) {
      const committed = await this.prisma.publisherEntityBinding.updateMany({
        where: {
          chatId: params.chatId,
          publisherBotId: this.publisherBotId,
          status: ChatBotMembershipStatus.ACTIVE,
          // FLAG: Diagnostic settlement must name the exact proof replaced by this CAS.
          // A concurrent newer proof or denial is supersession, never an old-proof success.
          ...(params.previous
            ? {
                botAccessCheckedAt: params.previous.botAccessCheckedAt,
                botAccessExpiresAt: params.previous.botAccessExpiresAt,
                botAccessState: params.previous.botAccessState,
              }
            : {}),
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
        return {
          outcome: 'superseded' as const,
          botAccess,
          snapshot,
          checkedAt,
          committedAt: null,
        };
      committedAt = new Date();
      if (params.previous) {
        await this.evidence?.recordCommittedProof({
          chatId: params.chatId,
          previous: params.previous,
          probeStartedAt: params.probeStartedAt,
          committedAt,
          outcome: botAccess.isAdmin || botAccess.isOwner ? 'confirmed' : 'denied',
        });
      }
    }
    return {
      outcome: (botAccess.isAdmin || botAccess.isOwner
        ? 'confirmed'
        : 'denied') as PublisherAccessProbeOutcome,
      botAccess,
      snapshot,
      checkedAt,
      // FLAG: The remote response is not a durable proof. This upper bound is captured
      // after the autocommit acknowledgement, before unrelated catalog/roster work.
      committedAt,
    };
  }
}
