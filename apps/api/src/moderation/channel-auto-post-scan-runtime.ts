import type { MaxClientService, MaxSendMessageOptions } from '../max/max-client.service';
import { ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { loadChannelAutoPostScanContexts } from './channel-auto-post-context';
import type { ChannelAutoPostLegacyRecovery } from './channel-auto-post-legacy-recovery';
import type {
  ChannelAutoPostAttachOutcome,
  ChannelAutoPostMessageText,
  ChannelAutoPostScanManager,
} from './channel-auto-post-runtime';
import { runChannelAutoPostScanBatch } from './channel-auto-post-scan-batch';
import { channelDecorationStart } from './channel-marketplace-decoration';
import type { ChannelPostDemandRuntime } from './channel-post-demand-runtime';
import type {
  ChannelAutoPostExecutionPlan,
  ManagedChannelContext,
} from './moderation.service.support';

export interface ChannelAutoPostAttachParams {
  chatId: string;
  messageId: string;
  text: string | null;
  textFormat?: MaxSendMessageOptions['textFormat'] | null;
  quickButtons?: ChannelAutoPostMessageText['quickButtons'];
  linkType: string | null;
  existingDialogButtonKinds?: readonly ('comments' | 'suggest')[];
  existingDialogThreadId?: string | null;
  managedChannel: ManagedChannelContext;
  source: 'webhook' | 'poll';
  schedulingOrigin?: 'durable_demand' | 'periodic_scan';
  senderId: string | null;
  senderAdminVerified: boolean;
  allowSenderlessEngagement: boolean;
  sourceMessageAt?: string | null;
  marketplaceAt?: Date | null;
}

type ScanBatchInput = Parameters<typeof runChannelAutoPostScanBatch>[0];
type MarketplaceScanClient = Partial<
  Pick<
    MaxClientService,
    'listMarketplaceChannelPostTargets' | 'getMarketplaceChannelPostActivation'
  >
>;

export class ChannelAutoPostScanRuntime {
  private marketplaceChannelScanCursor: string | undefined;

  async run(
    input: Pick<
      ScanBatchInput,
      | 'manager'
      | 'processChannel'
      | 'sleep'
      | 'isTransientLookupError'
      | 'onGlobalBackoff'
      | 'onFailure'
    > & {
      prisma: PrismaService;
      maxClient: MarketplaceScanClient;
      plan: ChannelAutoPostExecutionPlan;
      demand: Pick<ChannelPostDemandRuntime, 'selectChannels' | 'process'>;
      recovery: Pick<ChannelAutoPostLegacyRecovery, 'runIfDue'>;
      scanIntervalMs: number;
      rateLimitBackoffMs: number;
    },
  ): Promise<void> {
    const channelCandidates = await input.prisma.channelSettings.findMany({
      where: {
        chat: {
          entityType: ChatEntityType.CHANNEL,
        },
        OR: [
          {
            quickButtonsEnabled: true,
          },
          {
            postSignatureEnabled: true,
          },
          {
            commentsEnabled: true,
          },
          {
            postSuggestionsEnabled: true,
          },
        ],
      },
      select: {
        chatId: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
    const marketplaceChannels =
      (await input.maxClient.listMarketplaceChannelPostTargets?.(
        Math.max(1, input.plan.batchSize),
        this.marketplaceChannelScanCursor,
      )) ?? [];
    this.marketplaceChannelScanCursor = marketplaceChannels.length
      ? marketplaceChannels.at(-1)!.chatId
      : undefined;
    const candidates = [
      ...new Map(
        [...channelCandidates, ...marketplaceChannels].map((item) => [item.chatId, item]),
      ).values(),
    ];
    const demandRefs = await input.demand.selectChannels(
      input.plan.batchSize,
      input.scanIntervalMs,
    );
    const demandedIds = new Set(demandRefs.map((item) => item.chatId));
    const fallbackBudget = Math.max(0, input.plan.batchSize - demandRefs.length);
    const scanBatchRefs = [
      ...demandRefs.filter((item) => input.manager.isDemandDue(item.chatId)),
      ...(fallbackBudget > 0
        ? input.manager.selectBatch(
            candidates.filter((item) => !demandedIds.has(item.chatId)),
            fallbackBudget,
          )
        : []),
    ];
    const scanBatch = await loadChannelAutoPostScanContexts(
      input.prisma,
      scanBatchRefs.map((item) => item.chatId),
    );

    const encounteredTransientThrottle = await runChannelAutoPostScanBatch({
      channels: scanBatch,
      plan: input.plan,
      manager: input.manager,
      processChannel: (channel, options) =>
        demandedIds.has(channel.channelSettings.chatId)
          ? input.demand.process(channel, options.maxNewMessagesPerScan, input.scanIntervalMs)
          : input.processChannel(channel, options),
      sleep: input.sleep,
      isTransientLookupError: input.isTransientLookupError,
      onGlobalBackoff: input.onGlobalBackoff,
      onFailure: input.onFailure,
    });

    if (!encounteredTransientThrottle) {
      const recovery = await input.recovery.runIfDue();
      if (recovery.stopCurrentTick) {
        input.onGlobalBackoff(input.rateLimitBackoffMs);
      }
      input.manager.resetThrottle();
    }
  }
}

export async function processChannelAutoPostListedMessages(input: {
  managedChannel: ManagedChannelContext;
  messages: Awaited<ReturnType<MaxClientService['listMessages']>>;
  maxNewMessagesPerScan: number;
  maxClient: MarketplaceScanClient;
  manager: ChannelAutoPostScanManager;
  attach: (params: ChannelAutoPostAttachParams) => Promise<ChannelAutoPostAttachOutcome>;
}): Promise<void> {
  const { managedChannel, messages, maxNewMessagesPerScan } = input;
  const chatId = managedChannel.channelSettings.chatId;
  const marketplaceAt =
    (await input.maxClient.getMarketplaceChannelPostActivation?.(chatId)) ?? null;
  const enabledFrom = channelDecorationStart(managedChannel.channelSettings, marketplaceAt);
  if (enabledFrom === null) return;
  await input.manager.processListedMessages({
    chatId,
    messages,
    adminUserIds: managedChannel.adminUserIds,
    settingsUpdatedAtMs: enabledFrom,
    maxNewMessagesPerScan,
    quickButtonsEnabled: managedChannel.channelSettings.quickButtonsEnabled === true,
    attach: (normalized) =>
      input.attach({
        chatId,
        messageId: normalized.messageId,
        text: normalized.text,
        textFormat: normalized.textFormat,
        quickButtons: normalized.quickButtons,
        linkType: normalized.linkType,
        existingDialogButtonKinds: normalized.existingDialogButtonKinds,
        existingDialogThreadId: normalized.existingDialogThreadId,
        managedChannel,
        source: 'poll',
        schedulingOrigin: 'periodic_scan',
        sourceMessageAt: new Date(normalized.timestampMs).toISOString(),
        senderId: normalized.senderId,
        senderAdminVerified:
          normalized.senderId !== null && managedChannel.adminUserIds.includes(normalized.senderId),
        allowSenderlessEngagement: true,
      }),
  });
}
