import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { MaxActionLedgerService } from './max-action-ledger.service';
import { MaxBotLinkService, type MaxBotRouteRequest } from './max-bot-link.service';
import {
  isMaxApiCircuitOpenError,
  MaxClientService,
  type MaxActionLedgerContext,
  type MaxActionJob,
  type MaxPublishedMessage,
  type MaxSendMessageOptions,
} from './max-client.service';
import {
  ManagedEntityAccessLossService,
  type ManagedEntityAccessLossOperation,
} from './managed-entity-access-loss.service';
import {
  normalizeMaxRoutedMutationCanaryPercent,
  normalizeMaxRoutedMutationMode,
  parseMaxRoutedMutationCanaryEntityIds,
  shouldEnforceMaxRoutedMutation,
  type MaxRoutedMutationMode,
} from './max-routed-mutation-rollout.util';

type TerminalManagedEntityOutcome =
  | {
      kind: 'failed';
      error: UnrecoverableError;
      replacementBotId: string | null;
    }
  | {
      kind: 'skipped';
      reason: string;
    };

export type MaxActionDispatchResult = MaxPublishedMessage & {
  botId: string | null;
};

export type MaxActionDispatchExecutionOptions = {
  finalAttempt?: boolean;
  prepareAttempt?: (params: { botId: string | null; job: MaxActionJob }) => Promise<{
    text?: string;
    options?: MaxSendMessageOptions;
    ledgerContext?: MaxActionLedgerContext;
  }>;
  onDispatchAttempt?: (params: { botId: string | null; job: MaxActionJob }) => void;
};

const ROUTED_SEND_ACCESS_MAX_AGE_MS = 30 * 60_000;
const ROUTED_DESTRUCTIVE_ACCESS_MAX_AGE_MS = 5 * 60_000;

@Injectable()
export class MaxActionDispatchService {
  private readonly logger = new Logger(MaxActionDispatchService.name);
  private readonly routedMutationsMode: MaxRoutedMutationMode;
  private readonly routedMutationsCanaryPercent: number;
  private readonly routedMutationsCanaryEntityIds: ReadonlySet<string>;
  private readonly crossBotEditDeleteEnabled: boolean;

  constructor(
    private readonly maxClient: MaxClientService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly actionLedgerService?: MaxActionLedgerService,
    @Optional()
    private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() configService?: ConfigService,
  ) {
    this.routedMutationsMode = normalizeMaxRoutedMutationMode(
      configService?.get('MAX_ROUTED_MUTATIONS_MODE'),
    );
    this.routedMutationsCanaryPercent = normalizeMaxRoutedMutationCanaryPercent(
      configService?.get('MAX_ROUTED_MUTATIONS_CANARY_PERCENT'),
    );
    this.routedMutationsCanaryEntityIds = parseMaxRoutedMutationCanaryEntityIds(
      configService?.get('MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS'),
    );
    this.crossBotEditDeleteEnabled = this.readBoolean(
      configService?.get('MAX_CROSS_BOT_EDIT_DELETE_ENABLED'),
      false,
    );
  }

  async execute(
    job: MaxActionJob,
    options: MaxActionDispatchExecutionOptions = {},
  ): Promise<MaxActionDispatchResult | void> {
    const completedSendDispatch =
      typeof this.actionLedgerService?.getCompletedSendDispatchResult === 'function'
        ? await this.actionLedgerService.getCompletedSendDispatchResult(job)
        : null;
    const completedSendMessageId =
      completedSendDispatch?.remoteMessageId ??
      (typeof this.actionLedgerService?.getCompletedSendDispatchResult !== 'function'
        ? await this.actionLedgerService?.getCompletedSendDispatch?.(job)
        : null);
    if (completedSendMessageId) {
      return {
        messageId: completedSendMessageId,
        url: null,
        botId: completedSendDispatch?.dispatchBotId ?? job.botId?.trim() ?? null,
      };
    }
    const routedMutationEnforced = this.shouldEnforceRoutedFailover(job);
    const crossBotOperationAllowed =
      job.actionType !== 'DELETE_MESSAGE' || this.crossBotEditDeleteEnabled;
    const routedFailoverEnabled = routedMutationEnforced && crossBotOperationAllowed;
    const candidateBotIds = await this.resolveExecutionCandidateBotIds(job, {
      enforceFreshRoute: routedFailoverEnabled,
    });
    await this.actionLedgerService?.recordStarted(job);
    if (this.isRoutedJob(job) && !routedFailoverEnabled && candidateBotIds.length > 1) {
      candidateBotIds.splice(1);
    }
    const attemptedBotIds: string[] = [];
    let lastAccessError: UnrecoverableError | null = null;
    let lastPreDispatchError: Error | null = null;
    const allowImplicitDefaultAttempt = !this.isRoutedJob(job) && candidateBotIds.length === 0;
    const trackAttemptedBotIds = this.isRoutedJob(job) || Boolean(job.attemptedBotIds?.length);

    while (
      candidateBotIds.length > 0 ||
      (allowImplicitDefaultAttempt && attemptedBotIds.length === 0)
    ) {
      const candidateBotId = candidateBotIds.shift();
      if (candidateBotId && !this.isExecutableCandidate(candidateBotId)) {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: candidateBotId,
          },
          'Skipped non-executable routed MAX action candidate before dispatch',
        );
        continue;
      }

      let attemptJob: MaxActionJob = {
        ...job,
        ...(candidateBotId ? { botId: candidateBotId } : {}),
        ...(trackAttemptedBotIds
          ? { attemptedBotIds: [...attemptedBotIds, ...(candidateBotId ? [candidateBotId] : [])] }
          : {}),
      };
      if (candidateBotId) {
        attemptedBotIds.push(candidateBotId);
      }

      let dispatchAttemptStarted = false;
      try {
        if (
          candidateBotId &&
          routedFailoverEnabled &&
          !(await this.refreshStaleRoutedCandidateAccess(
            attemptJob,
            candidateBotIds,
            attemptedBotIds,
          ))
        ) {
          continue;
        }
        const prepared = await options.prepareAttempt?.({
          botId: candidateBotId ?? null,
          job: attemptJob,
        });
        if (prepared) {
          attemptJob = {
            ...attemptJob,
            ...(prepared.text !== undefined ? { text: prepared.text } : {}),
            ...(prepared.options !== undefined ? { options: prepared.options } : {}),
            ...(prepared.ledgerContext !== undefined
              ? { ledgerContext: prepared.ledgerContext }
              : {}),
          };
          await this.actionLedgerService?.recordPrepared?.(attemptJob);
        }
        options.onDispatchAttempt?.({
          botId: candidateBotId ?? null,
          job: attemptJob,
        });
        dispatchAttemptStarted = true;
        const executionResult = await this.maxClient.executeActionJob(attemptJob);
        await this.recordLedgerSucceeded(attemptJob);
        if (executionResult) {
          return {
            ...executionResult,
            botId: candidateBotId ?? attemptJob.botId?.trim() ?? null,
          };
        }
        return;
      } catch (error: unknown) {
        if (isMaxApiCircuitOpenError(error)) {
          if (this.isRoutedJob(job) && routedFailoverEnabled) {
            lastPreDispatchError = error;
            this.logger.warn(
              {
                actionType: job.actionType,
                chatId: job.chatId,
                skippedBotId: candidateBotId ?? error.botId,
                nextBotId: candidateBotIds[0] ?? null,
                retryAfterMs: error.retryAfterMs,
              },
              'Skipped routed MAX action candidate with an open shared circuit before dispatch',
            );
            continue;
          }

          await this.recordLedgerFailed(attemptJob, error, {
            exhausted: options.finalAttempt === true,
          });
          throw error;
        }

        if (!dispatchAttemptStarted) {
          if (
            this.isDefinitivePreparationCandidateRejection(error) &&
            candidateBotIds.length > 0 &&
            this.isRoutedJob(job) &&
            routedFailoverEnabled
          ) {
            lastPreDispatchError = error instanceof Error ? error : new Error(String(error));
            this.logger.warn(
              {
                actionType: job.actionType,
                chatId: job.chatId,
                failedBotId: candidateBotId ?? null,
                nextBotId: candidateBotIds[0] ?? null,
                statusCode: this.extractStatusCode(error),
              },
              'Retrying routed MAX action preparation with survivor after a definitive bot-scoped request rejection',
            );
            continue;
          }
          await this.recordLedgerFailed(attemptJob, error, {
            exhausted: options.finalAttempt === true,
          });
          throw error;
        }

        const terminalManagedEntityOutcome = await this.resolveTerminalManagedEntityOutcome(
          attemptJob,
          error,
        );
        if (terminalManagedEntityOutcome?.kind === 'skipped') {
          await this.recordLedgerSkipped(attemptJob, terminalManagedEntityOutcome.reason);
          return;
        }
        if (terminalManagedEntityOutcome?.kind === 'failed') {
          lastAccessError = terminalManagedEntityOutcome.error;
          const replacementBotId = terminalManagedEntityOutcome.replacementBotId;
          if (
            replacementBotId &&
            !attemptedBotIds.includes(replacementBotId) &&
            !candidateBotIds.includes(replacementBotId)
          ) {
            candidateBotIds.unshift(replacementBotId);
          }
          if (candidateBotIds.length > 0 && this.isRoutedJob(job) && routedFailoverEnabled) {
            this.logger.warn(
              {
                actionType: job.actionType,
                chatId: job.chatId,
                failedBotId: candidateBotId ?? null,
                nextBotId: candidateBotIds[0] ?? null,
              },
              'Retrying routed MAX action with survivor after definitive bot-scoped access rejection',
            );
            continue;
          }

          await this.recordLedgerFailed(attemptJob, terminalManagedEntityOutcome.error);
          throw terminalManagedEntityOutcome.error;
        }
        await this.recordLedgerFailed(attemptJob, error, {
          exhausted: options.finalAttempt === true,
        });
        throw error;
      }
    }

    const terminalError =
      lastAccessError ??
      lastPreDispatchError ??
      new UnrecoverableError(
        `MAX ${job.actionType} has no executable routed bot candidate for chat ${job.chatId}`,
      );
    await this.recordLedgerFailed(
      {
        ...job,
        ...(trackAttemptedBotIds ? { attemptedBotIds } : {}),
      },
      terminalError,
    );
    throw terminalError;
  }

  private async resolveExecutionCandidateBotIds(
    job: MaxActionJob,
    options: { enforceFreshRoute: boolean },
  ): Promise<string[]> {
    const storedCandidates = this.normalizeBotIds([job.botId, ...(job.candidateBotIds ?? [])]);
    if (!job.routing || !this.maxBotLinkService) {
      return storedCandidates;
    }

    try {
      const route =
        job.routing.purpose === 'channel_poll' &&
        typeof this.maxBotLinkService.resolveBotRouteForChannelPoll === 'function'
          ? await this.maxBotLinkService.resolveBotRouteForChannelPoll({ chatId: job.chatId })
          : await this.maxBotLinkService.resolveBotRoute(this.buildRouteRequest(job));
      const routingVersionChanged =
        typeof job.routing.routingVersion === 'number' &&
        typeof route.routingVersion === 'number' &&
        job.routing.routingVersion !== route.routingVersion;
      if (routingVersionChanged) {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            queuedRoutingVersion: job.routing.routingVersion,
            currentRoutingVersion: route.routingVersion,
          },
          'Recalculated stale routed MAX action before dispatch',
        );
      }
      const refreshedCandidates = this.normalizeBotIds(route.candidateBotIds);
      if (refreshedCandidates.length === 0) {
        return [];
      }
      if (routingVersionChanged) {
        return refreshedCandidates;
      }
      const stillEligibleStoredCandidates = storedCandidates.filter((botId) =>
        refreshedCandidates.includes(botId),
      );
      return options.enforceFreshRoute
        ? refreshedCandidates
        : stillEligibleStoredCandidates.length > 0
          ? [
              ...stillEligibleStoredCandidates,
              ...refreshedCandidates.filter(
                (botId) => !stillEligibleStoredCandidates.includes(botId),
              ),
            ]
          : refreshedCandidates;
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          error: this.extractErrorMessage(error),
        },
        options.enforceFreshRoute
          ? 'Failed to refresh routed MAX action candidates in worker; retrying before dispatch'
          : 'Failed to refresh routed MAX action candidates in shadow mode; using queued candidates',
      );
      if (options.enforceFreshRoute) {
        throw error;
      }
      return storedCandidates;
    }
  }

  private buildRouteRequest(job: MaxActionJob): MaxBotRouteRequest {
    return job.routing?.purpose === 'send_message' || job.routing?.purpose === 'channel_poll'
      ? {
          purpose: 'send_message',
          chatId: job.chatId,
          fallbackToPrimary: true,
        }
      : {
          purpose: 'moderation_action',
          chatId: job.chatId,
          action: job.routing?.action ?? 'moderate_member',
          fallbackToPrimary: true,
        };
  }

  private async refreshStaleRoutedCandidateAccess(
    job: MaxActionJob,
    remainingCandidateBotIds: string[],
    attemptedBotIds: readonly string[],
  ): Promise<boolean> {
    const botId = job.botId?.trim() ?? '';
    const maxAgeMs = this.resolveAccessSnapshotMaxAgeMs(job.actionType);
    const linkService = this.maxBotLinkService as
      | (MaxBotLinkService & {
          isBotAccessSnapshotStale?: MaxBotLinkService['isBotAccessSnapshotStale'];
          recordBotAccessProbe?: MaxBotLinkService['recordBotAccessProbe'];
        })
      | undefined;
    if (
      !botId ||
      maxAgeMs === null ||
      typeof linkService?.isBotAccessSnapshotStale !== 'function' ||
      typeof linkService.recordBotAccessProbe !== 'function'
    ) {
      return true;
    }

    const stale = await linkService.isBotAccessSnapshotStale({
      chatId: job.chatId,
      botId,
      maxAgeMs,
    });
    if (!stale) {
      return true;
    }

    const access = await this.maxClient.getCurrentChatMemberAccess(job.chatId, {
      botId,
      bypassCache: true,
      trafficClass: job.trafficClass ?? 'critical',
      actionHealthLane: job.actionHealthLane,
      sourceTag: job.sourceTag ?? 'routed_action_access_preflight',
      timeoutMs: job.timeoutMs,
    });
    await linkService.recordBotAccessProbe({
      chatId: job.chatId,
      botId,
      access,
      source: 'routed_action_preflight',
    });

    if (!job.routing) {
      return true;
    }
    const refreshedCandidates = await this.resolveExecutionCandidateBotIds(job, {
      enforceFreshRoute: true,
    });
    for (const refreshedBotId of refreshedCandidates) {
      if (
        refreshedBotId !== botId &&
        !attemptedBotIds.includes(refreshedBotId) &&
        !remainingCandidateBotIds.includes(refreshedBotId)
      ) {
        remainingCandidateBotIds.push(refreshedBotId);
      }
    }
    if (refreshedCandidates.includes(botId)) {
      return true;
    }

    this.logger.warn(
      {
        actionType: job.actionType,
        chatId: job.chatId,
        botId,
        nextBotId: remainingCandidateBotIds[0] ?? null,
      },
      'Skipped routed MAX action candidate after a fresh access probe removed its capability',
    );
    return false;
  }

  private resolveAccessSnapshotMaxAgeMs(actionType: MaxActionJob['actionType']): number | null {
    if (actionType === 'SEND_MESSAGE' || actionType === 'NOTIFY_MODERATORS') {
      return ROUTED_SEND_ACCESS_MAX_AGE_MS;
    }
    if (
      actionType === 'DELETE_MESSAGE' ||
      actionType === 'KICK_MEMBER' ||
      actionType === 'BAN_MEMBER' ||
      actionType === 'UNBAN_MEMBER'
    ) {
      return ROUTED_DESTRUCTIVE_ACCESS_MAX_AGE_MS;
    }
    return null;
  }

  private isExecutableCandidate(botId: string): boolean {
    if (!botId || !this.maxBotLinkService) {
      return true;
    }
    return Boolean(this.maxBotLinkService.getExecutableBotById(botId));
  }

  private isDefinitivePreparationCandidateRejection(error: unknown): boolean {
    const statusCode = this.extractStatusCode(error);
    return statusCode === 401 || statusCode === 403;
  }

  private isRoutedJob(job: MaxActionJob): boolean {
    return Boolean(job.routing) || (job.candidateBotIds?.length ?? 0) > 1;
  }

  private shouldEnforceRoutedFailover(job: MaxActionJob): boolean {
    if (!this.isRoutedJob(job)) {
      return false;
    }

    return shouldEnforceMaxRoutedMutation({
      mode: this.routedMutationsMode,
      canaryPercent: this.routedMutationsCanaryPercent,
      canaryEntityIds: this.routedMutationsCanaryEntityIds,
      entityId: job.chatId,
      rolloutKey: `${job.idempotencyKey}:${job.chatId}`,
    });
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
    return fallback;
  }

  private normalizeBotIds(values: readonly unknown[]): string[] {
    return Array.from(
      new Set(
        values
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0),
      ),
    );
  }

  private async resolveTerminalManagedEntityOutcome(
    job: MaxActionJob,
    error: unknown,
  ): Promise<TerminalManagedEntityOutcome | null> {
    if (!this.managedEntityAccessLossService) {
      return null;
    }

    const operation = this.resolveAccessLossOperation(job);
    if (!operation) {
      return null;
    }

    const result = await this.managedEntityAccessLossService.recordIfManagedEntityAccessLost({
      chatId: job.chatId,
      botId: job.botId,
      operation,
      source: `max_action:${job.actionType.toLowerCase()}`,
      error,
    });

    if (!result) {
      return null;
    }

    if (result.classification.kind === 'message_not_found' && job.actionType === 'DELETE_MESSAGE') {
      this.logger.debug(
        {
          chatId: job.chatId,
          messageId: job.messageId,
          actionType: job.actionType,
          code: result.classification.code,
        },
        'Skipped queued MAX delete for already missing message',
      );
      return {
        kind: 'skipped',
        reason: this.extractErrorMessage(error),
      };
    }

    if (result.reason) {
      return {
        kind: 'failed',
        error: this.createTerminalManagedEntityError(
          job,
          result.reason,
          error,
          Boolean(result.recorded),
        ),
        replacementBotId: result.recorded?.nextOwnerBotId ?? null,
      };
    }

    return null;
  }

  private resolveAccessLossOperation(job: MaxActionJob): ManagedEntityAccessLossOperation | null {
    switch (job.actionType) {
      case 'DELETE_MESSAGE':
        return 'delete';
      case 'SEND_MESSAGE':
      case 'NOTIFY_MODERATORS':
        return 'send';
      case 'KICK_MEMBER':
      case 'BAN_MEMBER':
      case 'UNBAN_MEMBER':
        return 'member_moderation';
      default:
        return null;
    }
  }

  private async recordLedgerSucceeded(job: MaxActionJob): Promise<void> {
    try {
      await this.actionLedgerService?.recordSucceeded(job);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(error),
        },
        'Failed to record successful MAX action ledger outcome',
      );
    }
  }

  private async recordLedgerSkipped(job: MaxActionJob, reason: string): Promise<void> {
    try {
      await this.actionLedgerService?.recordSkipped(job, reason);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(error),
        },
        'Failed to record skipped MAX action ledger outcome',
      );
    }
  }

  private async recordLedgerFailed(
    job: MaxActionJob,
    error: unknown,
    options: { exhausted?: boolean } = {},
  ): Promise<void> {
    try {
      if (options.exhausted === undefined) {
        await this.actionLedgerService?.recordFailed(job, error);
      } else {
        await this.actionLedgerService?.recordFailed(job, error, options);
      }
    } catch (ledgerError: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(ledgerError),
          originalError: this.extractErrorMessage(error),
        },
        'Failed to record failed MAX action ledger outcome',
      );
    }
  }

  private createTerminalManagedEntityError(
    job: MaxActionJob,
    reason: string,
    error: unknown,
    accessLossRecorded: boolean,
  ): UnrecoverableError {
    const terminalError = new UnrecoverableError(
      `MAX ${job.actionType} cannot be retried for chat ${job.chatId}: ${reason}`,
    );
    const response = (error as { response?: unknown })?.response;
    if (response !== undefined) {
      (terminalError as UnrecoverableError & { response?: unknown }).response = response;
    }
    const code = (error as { code?: unknown })?.code;
    if (code !== undefined) {
      (terminalError as UnrecoverableError & { code?: unknown }).code = code;
    }
    (
      terminalError as UnrecoverableError & { maxManagedEntityAccessLossRecorded?: boolean }
    ).maxManagedEntityAccessLossRecorded = accessLossRecorded;
    return terminalError;
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return String(error).trim();
  }

  private extractStatusCode(error: unknown): number | null {
    const statusCode = (error as { response?: { status?: unknown } })?.response?.status;
    return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : null;
  }
}
