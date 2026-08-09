import type { InternalChannelDialogButtonIdentity } from '../common/channel-dialog-button-identity.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedChannelContext } from './moderation.service.support';
import type {
  LegacyChannelEditRecoveryAuditCursor,
  LegacyChannelEditRecoveryCandidate,
  LegacyChannelEditRecoveryCandidatePage,
  ReplacementAttachMarkerStore,
} from './replacement-attach-marker.store';
import type { ChannelAutoPostAttachOutcome } from './channel-auto-post-runtime';

const LEGACY_RECOVERY_LOOKBACK_MS = 24 * 60 * 60_000;
const LEGACY_RECOVERY_MINIMUM_AGE_MS = 5 * 60_000;
const LEGACY_RECOVERY_SWEEP_INTERVAL_MS = 5 * 60_000;
const LEGACY_RECOVERY_SCAN_LIMIT = 100;
const LEGACY_RECOVERY_MUTATION_LIMIT = 3;
const LEGACY_RECOVERY_LOOKUP_LIMIT = 8;

type ExactChannelDialogLookupOptions = {
  trafficClass: 'background';
  actionHealthLane: 'background';
  sourceTag: 'channel_auto_post';
  botId?: string;
};

export type ExactChannelDialogButtonLookupPort = (
  chatId: string,
  messageId: string,
  options: ExactChannelDialogLookupOptions,
) => Promise<InternalChannelDialogButtonIdentity[] | null>;

export type ChannelAutoPostLegacyRecoveryAttachInput = {
  chatId: string;
  messageId: string;
  text: null;
  textFormat: null;
  linkType: null;
  existingDialogButtonKinds: readonly InternalChannelDialogButtonIdentity['kind'][];
  existingDialogThreadId: string | null;
  managedChannel: ManagedChannelContext;
  source: 'poll';
  senderId: null;
};

type LegacyRecoveryMarkerStore = Pick<
  ReplacementAttachMarkerStore,
  'listLegacyChannelEditRecoveryCandidates' | 'claimChannelAutoPost' | 'completeChannelAutoPost'
>;

type LegacyRecoveryLogger = {
  warn: (context: Record<string, unknown>, message: string) => void;
};

export type ChannelAutoPostLegacyRecoveryRunResult = {
  status: 'not_due' | 'completed' | 'deferred';
  deferReason:
    | 'same_channel_limit'
    | 'lookup_limit'
    | 'lookup_error'
    | 'mutation_limit'
    | 'attach_error'
    | 'marker_in_progress'
    | 'marker_error'
    | 'work_error'
    | null;
  stopCurrentTick: boolean;
  scannedCandidates: number;
  remoteLookups: number;
  mutationAttempts: number;
  terminalizedCandidates: number;
};

type FinishWithoutMutationOutcome = 'completed' | 'done' | 'deferred';

export class ChannelAutoPostLegacyRecovery {
  private nextSweepAtMs = 0;
  private auditCursor: LegacyChannelEditRecoveryAuditCursor | null = null;
  private inFlight = false;

  constructor(
    private readonly dependencies: {
      prisma: Pick<PrismaService, 'channelSettings'>;
      markerStore: LegacyRecoveryMarkerStore;
      lookupExactButtonIdentities: ExactChannelDialogButtonLookupPort;
      resolveUnifiedLookupBotId?: (params: {
        chatId: string;
        capability: 'background_scans';
        fallbackToPrimary: true;
      }) => Promise<string | null>;
      attach: (
        input: ChannelAutoPostLegacyRecoveryAttachInput,
      ) => Promise<ChannelAutoPostAttachOutcome>;
      logger?: LegacyRecoveryLogger;
      now?: () => number;
    },
  ) {}

  async runIfDue(): Promise<ChannelAutoPostLegacyRecoveryRunResult> {
    const nowMs = this.dependencies.now?.() ?? Date.now();
    if (this.inFlight || nowMs < this.nextSweepAtMs) {
      return this.result('not_due');
    }

    this.inFlight = true;
    this.nextSweepAtMs = nowMs + LEGACY_RECOVERY_SWEEP_INTERVAL_MS;
    try {
      let page: LegacyChannelEditRecoveryCandidatePage;
      try {
        page = await this.dependencies.markerStore.listLegacyChannelEditRecoveryCandidates({
          now: new Date(nowMs),
          limit: LEGACY_RECOVERY_SCAN_LIMIT,
          lookbackMs: LEGACY_RECOVERY_LOOKBACK_MS,
          minimumAgeMs: LEGACY_RECOVERY_MINIMUM_AGE_MS,
          auditCursor: this.auditCursor,
        });
      } catch (error: unknown) {
        this.warn(error, null, 'Failed to list legacy channel button recovery candidates');
        return this.result('deferred', 0, 'work_error');
      }

      let contexts: Map<string, ManagedChannelContext>;
      try {
        contexts = await this.loadContexts(page.candidates);
      } catch (error: unknown) {
        this.warn(error, null, 'Failed to load legacy channel button recovery contexts');
        return this.result('deferred', page.candidates.length, 'work_error');
      }

      const seenChatIds = new Set<string>();
      let remoteLookups = 0;
      let mutationAttempts = 0;
      let terminalizedCandidates = 0;
      let cursorCanAdvance = true;
      let deferReason: ChannelAutoPostLegacyRecoveryRunResult['deferReason'] = null;

      for (const candidate of page.candidates) {
        if (seenChatIds.has(candidate.chatId)) {
          cursorCanAdvance = false;
          deferReason ??= 'same_channel_limit';
          continue;
        }
        seenChatIds.add(candidate.chatId);

        const context = contexts.get(candidate.chatId) ?? null;
        if (!context) {
          const finished = await this.finishWithoutMutation(
            candidate,
            'SKIPPED',
            'Managed channel context is unavailable for legacy button recovery.',
            null,
          );
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        const commentsEnabled = context.channelSettings.commentsEnabled === true;
        const suggestionsEnabled = context.channelSettings.postSuggestionsEnabled === true;
        if (!commentsEnabled && !suggestionsEnabled) {
          const finished = await this.finishWithoutMutation(
            candidate,
            'SKIPPED',
            'Channel comments and post suggestions are disabled.',
            null,
          );
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        if (remoteLookups >= LEGACY_RECOVERY_LOOKUP_LIMIT) {
          cursorCanAdvance = false;
          deferReason ??= 'lookup_limit';
          continue;
        }

        let identities: InternalChannelDialogButtonIdentity[] | null;
        try {
          const lookupRoute = {
            chatId: candidate.chatId,
            capability: 'background_scans',
            fallbackToPrimary: true,
          } as const;
          const botId = await this.dependencies.resolveUnifiedLookupBotId?.(lookupRoute);
          remoteLookups += 1;
          identities = await this.dependencies.lookupExactButtonIdentities(
            candidate.chatId,
            candidate.messageId,
            {
              trafficClass: 'background',
              actionHealthLane: 'background',
              sourceTag: 'channel_auto_post',
              ...(botId ? { botId } : {}),
            },
          );
        } catch (error: unknown) {
          this.warn(error, candidate, 'Deferred legacy channel button recovery after lookup error');
          cursorCanAdvance = false;
          deferReason = 'lookup_error';
          break;
        }

        if (identities === null) {
          const finished = await this.finishWithoutMutation(
            candidate,
            'SKIPPED',
            'MAX confirmed that the legacy channel post no longer exists.',
            404,
          );
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        const existing = this.summarizeIdentities(candidate.chatId, identities);
        const commentsMissing = commentsEnabled && !existing.kinds.includes('comments');
        const suggestionsMissing = suggestionsEnabled && !existing.kinds.includes('suggest');
        if (!commentsMissing && !suggestionsMissing) {
          const finished = await this.finishWithoutMutation(candidate, 'SUCCEEDED', null, null);
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        if (mutationAttempts >= LEGACY_RECOVERY_MUTATION_LIMIT) {
          cursorCanAdvance = false;
          deferReason ??= 'mutation_limit';
          continue;
        }

        mutationAttempts += 1;
        try {
          const outcome = await this.dependencies.attach({
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            text: null,
            textFormat: null,
            linkType: null,
            existingDialogButtonKinds: existing.kinds,
            existingDialogThreadId: existing.threadId,
            managedChannel: {
              channelSettings: {
                ...context.channelSettings,
                postSignatureEnabled: false,
              },
              adminUserIds: context.adminUserIds,
            },
            source: 'poll',
            senderId: null,
          });
          if (outcome === 'in_progress' || outcome === 'noop') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
        } catch (error: unknown) {
          this.warn(error, candidate, 'Deferred legacy channel button recovery after attach error');
          cursorCanAdvance = false;
          deferReason = 'attach_error';
          break;
        }
      }

      if (cursorCanAdvance) {
        this.auditCursor = page.nextAuditCursor;
      }
      return {
        status: cursorCanAdvance ? 'completed' : 'deferred',
        deferReason,
        stopCurrentTick: deferReason === 'lookup_error' || deferReason === 'attach_error',
        scannedCandidates: page.candidates.length,
        remoteLookups,
        mutationAttempts,
        terminalizedCandidates,
      };
    } finally {
      this.inFlight = false;
    }
  }

  private async loadContexts(
    candidates: readonly LegacyChannelEditRecoveryCandidate[],
  ): Promise<Map<string, ManagedChannelContext>> {
    const chatIds = [...new Set(candidates.map((candidate) => candidate.chatId))];
    if (chatIds.length === 0) {
      return new Map();
    }
    const rows = await this.dependencies.prisma.channelSettings.findMany({
      where: {
        chatId: { in: chatIds },
        chat: { entityType: 'CHANNEL' },
      },
      include: {
        chat: {
          select: {
            admins: { select: { userId: true } },
          },
        },
      },
    });
    return new Map(
      rows.map((row) => [
        row.chatId,
        {
          channelSettings: row,
          adminUserIds: row.chat.admins.map((admin) => admin.userId),
        },
      ]),
    );
  }

  private summarizeIdentities(
    chatId: string,
    identities: readonly InternalChannelDialogButtonIdentity[],
  ): {
    kinds: InternalChannelDialogButtonIdentity['kind'][];
    threadId: string | null;
  } {
    const matching = identities.filter((identity) => identity.chatId === chatId);
    return {
      kinds: [...new Set(matching.map((identity) => identity.kind))],
      threadId:
        matching.find((identity) => identity.kind === 'comments' && identity.threadId)?.threadId ??
        matching.find((identity) => identity.threadId)?.threadId ??
        null,
    };
  }

  private async finishWithoutMutation(
    candidate: LegacyChannelEditRecoveryCandidate,
    status: 'SUCCEEDED' | 'SKIPPED',
    lastError: string | null,
    lastStatusCode: number | null,
  ): Promise<FinishWithoutMutationOutcome> {
    try {
      const claim = await this.dependencies.markerStore.claimChannelAutoPost({
        chatId: candidate.chatId,
        messageId: candidate.messageId,
        source: 'poll',
        botId: null,
        linkType: null,
        hasEngagementButtons: true,
      });
      if (claim.status !== 'claimed') {
        return claim.status === 'done' ? 'done' : 'deferred';
      }
      await this.dependencies.markerStore.completeChannelAutoPost({
        chatId: candidate.chatId,
        messageId: candidate.messageId,
        lockToken: claim.lockToken,
        status,
        source: 'poll',
        botId: null,
        linkType: null,
        deliveryMode: 'edit_message',
        lastError,
        lastStatusCode,
      });
      return 'completed';
    } catch (error: unknown) {
      this.warn(error, candidate, 'Deferred legacy channel button recovery after marker error');
      return 'deferred';
    }
  }

  private result(
    status: ChannelAutoPostLegacyRecoveryRunResult['status'],
    scannedCandidates = 0,
    deferReason: ChannelAutoPostLegacyRecoveryRunResult['deferReason'] = null,
  ): ChannelAutoPostLegacyRecoveryRunResult {
    return {
      status,
      deferReason,
      stopCurrentTick: false,
      scannedCandidates,
      remoteLookups: 0,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    };
  }

  private warn(
    error: unknown,
    candidate: LegacyChannelEditRecoveryCandidate | null,
    message: string,
  ): void {
    this.dependencies.logger?.warn(
      {
        ...(candidate
          ? {
              chatId: candidate.chatId,
              messageId: candidate.messageId,
              evidence: candidate.evidence,
            }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      },
      message,
    );
  }
}
