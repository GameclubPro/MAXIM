import {
  MAX_PUBLICATION_TARGETS,
  type PublicationAudienceInput,
  type PublicationTargetInput,
} from '@maxim/contracts/publication';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BroadcastLinkButton, ManagedEntityType } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChatEntityType,
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
import { ManagedEntitiesService } from './managed-entities.service';
import { PublisherDialogContextService } from './publisher-dialog-context.service';
import { PublisherPolicyService } from './publisher-policy.service';

const PUBLISHER_BLOCKED_RETRY_MS = 60_000;
const DIALOG_CONTEXT_PREPARE_CONCURRENCY = 4;
const PUBLICATION_ADMIN_ACCESS_CHECK_CONCURRENCY = 4;
export const LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE = 'LEGACY_PUBLICATION_EXECUTION_IMMUTABLE';

export type PublisherPublicationTarget = {
  chatId: string;
  entityType: ManagedEntityType;
};

export type ResolvedPublicationTarget = PublicationTargetInput & {
  title: string;
  avatarUrl: string | null;
  link: string | null;
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
    private readonly readiness: PublisherReadinessService,
    private readonly dialogContexts: PublisherDialogContextService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    private readonly publisherPolicyService: PublisherPolicyService,
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

  async resolveAudienceTargets(
    user: AuthUser,
    audience: PublicationAudienceInput,
    dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.LEGACY_ROUTED,
  ): Promise<ResolvedPublicationTarget[]> {
    if (dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
      const requestedTargets =
        audience.selection === 'SELECTED'
          ? audience.targets.map((target) => ({
              chatId: target.chatId,
              entityType: target.entityType,
            }))
          : undefined;
      const publisherTargets = await this.publisherPolicyService.resolvePublicationTargets(
        user,
        requestedTargets,
      );
      const resolved = publisherTargets.filter((target) =>
        audience.selection === 'ALL_CHATS'
          ? target.entityType === 'chat'
          : audience.selection === 'ALL_CHANNELS'
            ? target.entityType === 'channel'
            : true,
      );
      this.assertResolvedTargetCount(resolved);
      return resolved;
    }

    const [chats, channels] = await Promise.all([
      this.managedEntitiesService.listChats(user, { fresh: false }),
      this.managedEntitiesService.listChannels(user, { fresh: false }),
    ]);
    const available = [...chats, ...channels].map((item) => ({
      chatId: item.id,
      entityType: item.entityType,
      title: item.title,
      avatarUrl: item.avatarUrl ?? null,
      link: item.link ?? null,
    }));
    const byKey = new Map(
      available.map((target) => [`${target.entityType}:${target.chatId}`, target]),
    );
    let resolved: ResolvedPublicationTarget[];
    if (audience.selection === 'SELECTED') {
      resolved = audience.targets.map((target) => {
        const availableTarget = byKey.get(`${target.entityType}:${target.chatId}`);
        if (!availableTarget) {
          throw new BadRequestException(
            'Некоторые выбранные чаты или каналы больше недоступны. Обновите список.',
          );
        }
        return availableTarget;
      });
    } else {
      resolved = available.filter((target) =>
        audience.selection === 'ALL_CHATS'
          ? target.entityType === 'chat'
          : audience.selection === 'ALL_CHANNELS'
            ? target.entityType === 'channel'
            : true,
      );
    }
    this.assertResolvedTargetCount(resolved);
    await mapWithConcurrencyLimit(
      resolved,
      PUBLICATION_ADMIN_ACCESS_CHECK_CONCURRENCY,
      async (target) => this.assertTargetAdminAccess(target, user),
    );
    return resolved;
  }

  resolvePersistedTargets(
    user: AuthUser,
    targets: readonly { targetChatId: string; entityType: ChatEntityType }[],
    dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.LEGACY_ROUTED,
  ): Promise<ResolvedPublicationTarget[]> {
    return this.resolveAudienceTargets(
      user,
      {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: targets.map((target) => ({
          chatId: target.targetChatId,
          entityType: target.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
        })),
      },
      dispatchProfile,
    );
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
    const preparedContexts = await mapWithConcurrencyLimit(
      [...targets],
      DIALOG_CONTEXT_PREPARE_CONCURRENCY,
      async (target) => ({
        chatId: target.chatId,
        dialogBotId: requiredBotId!,
        context: await this.dialogContexts.prepare({
          chatId: target.chatId,
          entityType: target.entityType,
          dialogBotId: requiredBotId!,
          customButtons,
          includeManagedDialogs: target.entityType === 'chat',
        }),
      }),
    );
    const routeByChatId = new Map(routes.map((route) => [route.chatId, route]));
    const dialogBotIds = new Map(preparedContexts.map((item) => [item.chatId, item.dialogBotId]));
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

  private assertResolvedTargetCount(targets: readonly ResolvedPublicationTarget[]): void {
    if (targets.length === 0) {
      throw new BadRequestException('Нет доступных получателей для публикации.');
    }
    if (targets.length > MAX_PUBLICATION_TARGETS) {
      throw new BadRequestException(
        `Можно выбрать не больше ${MAX_PUBLICATION_TARGETS} чатов и каналов.`,
      );
    }
  }

  private async assertTargetAdminAccess(target: PublicationTargetInput, user: AuthUser) {
    return target.entityType === 'channel'
      ? this.managedEntitiesService.assertChannelAdminAccess(target.chatId, user)
      : this.managedEntitiesService.assertChatAdminAccess(target.chatId, user);
  }
}
