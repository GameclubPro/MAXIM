import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BroadcastLinkButton, ManagedEntityType } from '@maxim/contracts';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import {
  Prisma,
  PublicationDispatchProfile,
  PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import {
  PublisherReadinessService,
  type PublisherReadyRoute,
} from '../publisher/publisher-readiness.service';
import {
  PUBLISHER_SETUP_REQUIRED_CODE,
  resolveNewPublicationDispatchRoute,
  type PublisherDispatchRoute,
} from '../publisher/publisher-route';
import { mapWithConcurrencyLimit } from './admin-legacy-utils';
import { PublisherDialogContextService } from './publisher-dialog-context.service';

const PUBLISHER_BLOCKED_RETRY_MS = 60_000;
const ROUTE_LOOKUP_CONCURRENCY = 4;
export const LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE =
  'LEGACY_PUBLICATION_EXECUTION_IMMUTABLE';

export type PublisherPublicationTarget = {
  chatId: string;
  entityType: ManagedEntityType;
};

type PublisherOccurrence = {
  id: string;
  publicationId: string;
  scheduleRevision: number;
  dispatchProfile: PublicationDispatchProfile;
};

@Injectable()
export class PublicationPublisherRoutingService {
  private readonly logger = new Logger(PublicationPublisherRoutingService.name);

  static assertRootUpdateAllowed(
    dispatchProfile: PublicationDispatchProfile,
    mutatesExecution: boolean,
  ): void {
    if (dispatchProfile !== PublicationDispatchProfile.LEGACY_ROUTED || !mutatesExecution) {
      return;
    }
    throw new ConflictException({
      code: LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE,
      message:
        'Нельзя менять содержимое или расписание старой публикации. Создайте новую публикацию для отправки через Публик.',
    });
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly readiness: PublisherReadinessService,
    private readonly dialogContexts: PublisherDialogContextService,
  ) {}

  requireNewRoute(): PublisherDispatchRoute {
    const route = resolveNewPublicationDispatchRoute(this.configService);
    if (route) {
      return route;
    }
    throw new ConflictException({
      code: PUBLISHER_SETUP_REQUIRED_CODE,
      message: 'Бот Публик ещё не настроен для новых публикаций.',
    });
  }

  async assertTargetsReady(
    targets: readonly PublisherPublicationTarget[],
    expectedBotId: string | null | undefined,
  ): Promise<PublisherReadyRoute[]> {
    const routes = await this.readiness.assertTargetsReady(targets, 'publication');
    const expected = expectedBotId?.trim() ?? '';
    const mismatch = routes.find((route) => !expected || route.requiredBotId !== expected);
    if (mismatch) {
      throw new PublisherSetupRequiredException([mismatch.chatId], 'publisher_bot_changed');
    }
    return routes;
  }

  async prepareOccurrenceRoute(
    dispatchProfile: PublicationDispatchProfile,
    requiredBotId: string | null | undefined,
    targets: readonly PublisherPublicationTarget[],
    customButtons: readonly BroadcastLinkButton[],
  ) {
    const broadcastData = {
      dispatchProfile,
      requiredBotId: requiredBotId ?? null,
    };
    if (dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
      return {
        broadcastData,
        deliveryDataByChatId: new Map(
          targets.map((target) => [
            target.chatId,
            {
              ...broadcastData,
              dialogBotId: null,
              publisherDialogContext: Prisma.DbNull,
              publicationPolicyRevision: null,
            },
          ]),
        ),
      };
    }
    const routes = await this.assertTargetsReady(targets, requiredBotId);
    const resolvedDialogBots = await mapWithConcurrencyLimit(
      [...targets],
      ROUTE_LOOKUP_CONCURRENCY,
      async (target) => ({
        chatId: target.chatId,
        botId: await this.maxBotLinkService.getStoredChatPrimaryBotId(target.chatId, {
          bypassCache: true,
        }),
      }),
    );
    const missing = resolvedDialogBots.find((item) => !item.botId);
    if (missing) {
      throw new ConflictException({
        code: PUBLISHER_SETUP_REQUIRED_CODE,
        message: 'Для публикации не найден основной бот, который откроет комментарии.',
        chatId: missing.chatId,
      });
    }
    const preparedContexts = await mapWithConcurrencyLimit(
      [...targets],
      ROUTE_LOOKUP_CONCURRENCY,
      async (target) => ({
        chatId: target.chatId,
        context: await this.dialogContexts.prepare({
          chatId: target.chatId,
          entityType: target.entityType,
          dialogBotId: resolvedDialogBots.find((item) => item.chatId === target.chatId)!.botId!,
          customButtons,
        }),
      }),
    );
    const routeByChatId = new Map(routes.map((route) => [route.chatId, route]));
    const dialogBotIds = new Map(resolvedDialogBots.map((item) => [item.chatId, item.botId!]));
    const dialogContextByChatId = new Map(
      preparedContexts.map((item) => [item.chatId, item.context]),
    );
    return {
      broadcastData,
      deliveryDataByChatId: new Map(
        targets.map((target) => [
          target.chatId,
          {
            ...broadcastData,
            dialogBotId: dialogBotIds.get(target.chatId) ?? null,
            publisherDialogContext:
              (dialogContextByChatId.get(target.chatId) as Prisma.InputJsonValue | undefined) ??
              Prisma.DbNull,
            publicationPolicyRevision: routeByChatId.get(target.chatId)?.policyRevision ?? null,
          },
        ]),
      ),
    };
  }

  blockedRetryBefore(now: Date): Date {
    return new Date(now.getTime() - PUBLISHER_BLOCKED_RETRY_MS);
  }

  async deferOccurrenceIfBlocked(
    occurrence: PublisherOccurrence,
    error: unknown,
  ): Promise<boolean> {
    if (
      occurrence.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      !(error instanceof PublisherSetupRequiredException)
    ) {
      return false;
    }
    await this.prisma.publicationOccurrence.updateMany({
      where: {
        id: occurrence.id,
        scheduleRevision: occurrence.scheduleRevision,
        status: PublicationOccurrenceStatus.SCHEDULED,
        legacyBroadcasts: { none: {} },
      },
      data: {
        dispatchBlockerCode: error.blockerCode.slice(0, 96),
        dispatchBlockedAt: new Date(),
      },
    });
    this.logger.warn(
      {
        occurrenceId: occurrence.id,
        publicationId: occurrence.publicationId,
        blockerCode: error.blockerCode,
      },
      'Deferred Publik publication until its target route is ready',
    );
    return true;
  }
}
