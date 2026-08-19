import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import {
  MaxActionDispatchService,
  type MaxActionDispatchExecutionOptions,
} from './max-action-dispatch.service';
import { MaxActionNoExecutableRouteError } from './max-action-dispatch-error';
import { MaxBotLinkService, type MaxBotRoute } from './max-bot-link.service';
import type {
  MaxActionLedgerContext,
  MaxActionJob,
  MaxApiTrafficClass,
  MaxPublishedMessage,
  MaxSendMessageOptions,
} from './max-client.service';
import { MaxClientService } from './max-client.service';

export type MaxRoutedPublicationRoutePurpose = 'send_message' | 'channel_poll';

export type MaxRoutedPublicationAttemptContext = {
  botId: string;
  job: MaxActionJob;
};

export type MaxRoutedPublicationRequest = {
  entityId: string;
  logicalIdempotencyKey: string;
  text: string;
  options?: MaxSendMessageOptions;
  routePurpose?: MaxRoutedPublicationRoutePurpose;
  trafficClass: MaxApiTrafficClass;
  actionHealthLane?: MaxActionJob['actionHealthLane'];
  sourceTag: string;
  sendRouteHalfOpenProbe?: 'publication_exact_verification';
  timeoutMs?: number;
  ignoreFailureMetricStatuses?: readonly number[];
  prepareAttempt?: (context: MaxRoutedPublicationAttemptContext) => Promise<{
    text?: string;
    options?: MaxSendMessageOptions;
    ledgerContext?: MaxActionLedgerContext;
  }>;
  onDispatchAttempt?: (context: MaxRoutedPublicationAttemptContext) => void | Promise<void>;
};

export type MaxRoutedPublicationResult = MaxPublishedMessage & {
  botId: string;
  candidateBotIds: string[];
  routingVersion: number | null;
};

const MANAGED_POLL_ROUTE_ACCESS_MAX_AGE_MS = 30 * 60_000;

@Injectable()
export class MaxRoutedPublicationService {
  private readonly logger = new Logger(MaxRoutedPublicationService.name);

  constructor(
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxActionDispatchService: MaxActionDispatchService,
    private readonly maxClientService: MaxClientService,
  ) {}

  async publish(request: MaxRoutedPublicationRequest): Promise<MaxRoutedPublicationResult> {
    const entityId = request.entityId.trim();
    const logicalIdempotencyKey = request.logicalIdempotencyKey.trim();
    if (!entityId) {
      throw new Error('entityId is required for routed MAX publication');
    }
    if (!logicalIdempotencyKey) {
      throw new Error('logicalIdempotencyKey is required for routed MAX publication');
    }

    const routePurpose = request.routePurpose ?? 'send_message';
    const baseJob: MaxActionJob = {
      actionType: 'SEND_MESSAGE',
      chatId: entityId,
      trafficClass: request.trafficClass,
      ...(request.actionHealthLane ? { actionHealthLane: request.actionHealthLane } : {}),
      sourceTag: request.sourceTag,
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.ignoreFailureMetricStatuses?.length
        ? { ignoreFailureMetricStatuses: [...request.ignoreFailureMetricStatuses] }
        : {}),
      text: request.text,
      ...(request.options ? { options: request.options } : {}),
      attempt: 1,
      idempotencyKey: logicalIdempotencyKey,
      createdAt: new Date().toISOString(),
    };
    const recovered = await this.maxActionDispatchService.recoverCompletedSend(baseJob);
    const recoveredBotId = recovered?.botId?.trim();
    if (recovered && recoveredBotId) {
      const url =
        recovered.url ??
        (await this.resolveRecoveredMessageUrl(request, {
          messageId: recovered.messageId,
          botId: recoveredBotId,
        }));
      return {
        messageId: recovered.messageId,
        url,
        ...(recovered.chatId ? { chatId: recovered.chatId } : {}),
        botId: recoveredBotId,
        candidateBotIds: [recoveredBotId],
        routingVersion: null,
      };
    }

    const route = await this.resolveFreshRoute(entityId, routePurpose, request);
    const candidateBotIds = this.normalizeBotIds(route.candidateBotIds);
    if (routePurpose === 'channel_poll' && candidateBotIds.length === 0) {
      throw new MaxActionNoExecutableRouteError('SEND_MESSAGE', entityId);
    }
    const job: MaxActionJob = {
      ...baseJob,
      ...(candidateBotIds[0] ? { botId: candidateBotIds[0] } : {}),
      candidateBotIds,
      routing: {
        purpose: routePurpose,
        primaryBotId: route.primaryBotId,
        reason: route.reason,
        routingVersion: route.routingVersion ?? null,
        ...(request.sendRouteHalfOpenProbe
          ? { sendRouteHalfOpenProbe: request.sendRouteHalfOpenProbe }
          : {}),
      },
    };
    const executionOptions: MaxActionDispatchExecutionOptions = {
      ...(request.prepareAttempt
        ? {
            prepareAttempt: async ({ botId, job: attemptJob }) => {
              if (!botId) {
                throw new UnrecoverableError(
                  `MAX publication ${logicalIdempotencyKey} has no executable bot candidate`,
                );
              }
              return request.prepareAttempt!({ botId, job: attemptJob });
            },
          }
        : {}),
      ...(request.onDispatchAttempt
        ? {
            onDispatchAttempt: async ({ botId, job: attemptJob }) => {
              if (botId) {
                await request.onDispatchAttempt!({ botId, job: attemptJob });
              }
            },
          }
        : {}),
    };
    const result = await this.maxActionDispatchService.execute(job, executionOptions);
    if (!result || !result.botId) {
      throw new UnrecoverableError(
        `MAX publication ${logicalIdempotencyKey} completed without a routed send result`,
      );
    }

    const dispatchedBotId = result.botId;
    const url =
      result.url ??
      (await this.resolveRecoveredMessageUrl(request, {
        messageId: result.messageId,
        botId: dispatchedBotId,
      }));
    return {
      messageId: result.messageId,
      url,
      ...(result.chatId ? { chatId: result.chatId } : {}),
      botId: dispatchedBotId,
      candidateBotIds,
      routingVersion: route.routingVersion ?? null,
    };
  }

  private async resolveRecoveredMessageUrl(
    request: MaxRoutedPublicationRequest,
    result: { messageId: string; botId: string },
  ): Promise<string | null> {
    try {
      return await this.maxClientService.resolveMessageLink(result.messageId, {
        botId: result.botId,
        trafficClass: request.trafficClass,
        sourceTag: request.sourceTag,
        ...(request.ignoreFailureMetricStatuses?.length
          ? { ignoreFailureMetricStatuses: [...request.ignoreFailureMetricStatuses] }
          : {}),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityId: request.entityId,
          messageId: result.messageId,
          botId: result.botId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to hydrate recovered routed MAX publication URL',
      );
      return null;
    }
  }

  private async resolveFreshRoute(
    chatId: string,
    purpose: MaxRoutedPublicationRoutePurpose,
    request: MaxRoutedPublicationRequest,
  ): Promise<MaxBotRoute> {
    if (purpose === 'channel_poll') {
      const route = await this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
      if (this.normalizeBotIds(route.candidateBotIds).length > 0) {
        return route;
      }
      return this.hydrateManagedPollRoute(chatId, route, request);
    }
    return this.maxBotLinkService.resolveBotRoute({
      purpose: 'send_message',
      chatId,
      fallbackToPrimary: true,
      allowHalfOpenProbe: request.sendRouteHalfOpenProbe === 'publication_exact_verification',
    });
  }

  private async hydrateManagedPollRoute(
    chatId: string,
    emptyRoute: MaxBotRoute,
    request: MaxRoutedPublicationRequest,
  ): Promise<MaxBotRoute> {
    const probeRoute = await this.maxBotLinkService.resolveBotRoute({
      purpose: 'send_message',
      chatId,
      fallbackToPrimary: true,
    });
    const probeCandidateBotIds = this.normalizeBotIds(probeRoute.candidateBotIds);
    if (probeCandidateBotIds.length === 0) {
      return emptyRoute;
    }

    let refreshedRoute = emptyRoute;
    for (const botId of probeCandidateBotIds) {
      const stale = await this.maxBotLinkService.isBotAccessSnapshotStale({
        chatId,
        botId,
        maxAgeMs: MANAGED_POLL_ROUTE_ACCESS_MAX_AGE_MS,
      });
      if (!stale) {
        continue;
      }

      try {
        const access = await this.maxClientService.getCurrentChatMemberAccess(chatId, {
          botId,
          bypassCache: true,
          trafficClass: request.trafficClass,
          ...(request.actionHealthLane ? { actionHealthLane: request.actionHealthLane } : {}),
          sourceTag: request.sourceTag,
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        });
        await this.maxBotLinkService.recordBotAccessProbe({
          chatId,
          botId,
          access,
          source: 'managed_poll_route_hydration',
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            botId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to hydrate a managed poll route candidate',
        );
        continue;
      }

      refreshedRoute = await this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
      if (this.normalizeBotIds(refreshedRoute.candidateBotIds).length > 0) {
        return refreshedRoute;
      }
    }
    return refreshedRoute;
  }

  private normalizeBotIds(values: readonly unknown[]): string[] {
    return Array.from(
      new Set(
        values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean),
      ),
    );
  }
}
