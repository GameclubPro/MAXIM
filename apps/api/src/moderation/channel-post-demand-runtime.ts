import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  parseChannelAutoPostListedMessage,
  type ChannelAutoPostAttachOutcome,
  type ChannelAutoPostListedMessage,
} from './channel-auto-post-runtime';
import {
  claimChannelPostDemandChannels,
  claimChannelPostDemandItems,
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
      maxClient: Pick<MaxClientService, 'getExactMessageRow'>;
      resolveBotId: (chatId: string) => Promise<string | null>;
      isMessageHeld: (chatId: string, messageId: string) => Promise<boolean>;
      recordReadAccessLoss: (
        chatId: string,
        botId: string,
        startedAt: Date,
        error: unknown,
      ) => Promise<boolean>;
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
    const enabled =
      settings.postSignatureEnabled ||
      settings.quickButtonsEnabled ||
      settings.commentsEnabled ||
      settings.postSuggestionsEnabled;
    let botId: string | null = null;
    for (let attempt = 0; attempt < Math.max(1, Math.min(32, maxMessages)); attempt++) {
      // FLAG: Reserve only the post actually visited. A failed first read must not
      // postpone its unvisited siblings and recreate head-of-line starvation.
      const [item] = await claimChannelPostDemandItems(prisma, settings.chatId, 1, retryMs);
      if (!item) break;
      if (
        !enabled ||
        item.expiresAt.getTime() <= Date.now() ||
        item.sourceAt.getTime() < settings.updatedAt.getTime() ||
        (await this.deps.isMessageHeld(item.chatId, item.messageId))
      ) {
        await settleChannelPostDemand(prisma, item);
        continue;
      }
      botId ??= await this.deps.resolveBotId(item.chatId);
      if (!botId) break;
      const startedAt = new Date();
      let raw: Awaited<ReturnType<MaxClientService['getExactMessageRow']>>;
      try {
        raw = await maxClient.getExactMessageRow(item.chatId, item.messageId, {
          botId,
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        });
      } catch (error: unknown) {
        if (await this.deps.recordReadAccessLoss(item.chatId, botId, startedAt, error)) return;
        throw error;
      }
      // Missing MAX content is ambiguous. Retain the hint until its original horizon.
      if (!raw) continue;
      const message = parseChannelAutoPostListedMessage(
        raw,
        item.chatId,
        settings.quickButtonsEnabled,
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
    await prisma.$transaction((tx) => idleChannelPostDemand(tx, settings.chatId), {
      timeout: 2_000,
      maxWait: 500,
    });
  }
}
