import { channelDecorationStart, channelSettingsForSource } from './channel-marketplace-decoration';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import { isMaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import type { PrismaService } from '../prisma/prisma.service';
import {
  parseChannelAutoPostListedMessage,
  type ChannelAutoPostAttachOutcome,
  type ChannelAutoPostListedMessage,
} from './channel-auto-post-runtime';
import {
  claimChannelPostDemandChannels,
  claimChannelPostDemandItems,
  deferUnavailableChannelPostDemand,
  idleChannelPostDemand,
  purgeExpiredChannelPostDemands,
  settleChannelPostDemand,
} from './channel-post-demand';
import type { ManagedChannelContext } from './moderation.service.support';

export class ChannelPostDemandRuntime {
  private tick = 0;
  constructor(
    private readonly deps: {
      prisma: PrismaService;
      maxClient: Pick<MaxClientService, 'getExactMessageRow'> &
        Partial<Pick<MaxClientService, 'getMarketplaceChannelPostActivation'>>;
      resolveBotId: (chatId: string) => Promise<string | null>;
      isMessageHeld: (chatId: string, messageId: string) => Promise<boolean>;
      attach: (
        context: ManagedChannelContext,
        message: ChannelAutoPostListedMessage,
      ) => Promise<ChannelAutoPostAttachOutcome>;
    },
  ) {}

  async selectChannels(maxChannels: number, retryMs: number): Promise<{ chatId: string }[]> {
    const budget = maxChannels === 1 ? (++this.tick % 4 === 0 ? 0 : 1) : maxChannels - 1;
    await purgeExpiredChannelPostDemands(this.deps.prisma);
    // FLAG: Reserve fallback polling capacity. A hot channel consumes one channel slot,
    // regardless of its retained message count; child attempts have a separate bounded page.
    return claimChannelPostDemandChannels(this.deps.prisma, budget, retryMs);
  }

  async process(
    context: ManagedChannelContext,
    maxMessages: number,
    retryMs: number,
  ): Promise<void> {
    const { prisma, maxClient } = this.deps;
    const settings = context.channelSettings;
    const activation =
      (await maxClient.getMarketplaceChannelPostActivation?.(settings.chatId)) ?? null;
    const enabledFrom = channelDecorationStart(settings, activation);
    let botId: string | null = null;
    try {
      for (let attempt = 0; attempt < Math.max(1, Math.min(32, maxMessages)); attempt++) {
        // FLAG: Reserve only the post actually visited. A failed first read must not
        // postpone its unvisited siblings and recreate head-of-line starvation.
        const [item] = await claimChannelPostDemandItems(prisma, settings.chatId, 1, retryMs);
        if (!item) break;
        if (
          enabledFrom === null ||
          item.expiresAt.getTime() <= Date.now() ||
          item.sourceAt.getTime() < enabledFrom ||
          (await this.deps.isMessageHeld(item.chatId, item.messageId))
        ) {
          await settleChannelPostDemand(prisma, item);
          continue;
        }
        // FLAG: A confirmed exact-object receipt may retire a scheduling hint without
        // another MAX read. Pending/failed/unknown effects retain their normal fences.
        const marker = await prisma.channelAutoPostAttachMarker.findUnique({
          where: { chatId_messageId: { chatId: item.chatId, messageId: item.messageId } },
          select: { status: true },
        });
        if (marker?.status === 'SUCCEEDED') {
          await settleChannelPostDemand(prisma, item);
          continue;
        }
        botId ??= await this.deps.resolveBotId(item.chatId);
        if (!botId) break;
        // FLAG: This request reads one message, not the channel's membership. Even a
        // chat-shaped MAX error cannot revoke grants here; lifecycle evidence owns that.
        let raw: Awaited<ReturnType<MaxClientService['getExactMessageRow']>>;
        try {
          raw = await maxClient.getExactMessageRow(item.chatId, item.messageId, {
            botId,
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
          });
        } catch (error: unknown) {
          // FLAG: Only an old source's exact GET unavailability reduces its retry rate.
          // This is neither absence proof nor an access transition. Quota, server and
          // mutation failures keep their existing propagation and admission boundaries.
          const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
          if (
            item.sourceAt.getTime() <= Date.now() - 5 * 60_000 &&
            (status === 404 || isMaxExactMessageLookupMissingIdError(error))
          )
            await deferUnavailableChannelPostDemand(prisma, item);
          throw error;
        }
        // Missing MAX content is ambiguous. Retain the hint until its original horizon.
        if (!raw) {
          if (item.sourceAt.getTime() <= Date.now() - 5 * 60_000)
            await deferUnavailableChannelPostDemand(prisma, item);
          continue;
        }
        const message = parseChannelAutoPostListedMessage(
          raw,
          item.chatId,
          channelSettingsForSource(settings, item.sourceAt.toISOString()).quickButtonsEnabled,
        );
        if (
          !message ||
          message.messageId !== item.messageId ||
          message.timestampMs !== item.sourceAt.getTime()
        )
          continue;
        const outcome = await this.deps.attach(context, message);
        if (outcome === 'attached' || outcome === 'noop' || outcome === 'skipped')
          await settleChannelPostDemand(prisma, item);
      }
    } finally {
      await prisma.$transaction((tx) => idleChannelPostDemand(tx, settings.chatId), {
        timeout: 2_000,
        maxWait: 500,
      });
    }
  }
}
