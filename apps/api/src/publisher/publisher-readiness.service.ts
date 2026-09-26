import {
  publisherEntityReadinessSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntityReadiness,
} from '@maxim/contracts/publisher';
import { MAX_PUBLICATION_TARGETS } from '@maxim/contracts/publication';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
} from '../max/max-bot-access-policy.util';
import { resolveConfiguredPublisherBotId } from './publisher-route';
import { PublisherSetupRequiredException } from './publisher-errors';
import { PublisherRuntimeHeartbeatReaderService } from './publisher-runtime-heartbeat.service';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';
import { publisherRefreshEvidenceWhere } from './publisher-entity-connection.util';
import { stageMissingPublicationActor } from './publisher-publication-actor-candidate';

export type PublisherFeature =
  | 'publication'
  | 'vk_publish'
  | 'chat_comments'
  | 'channel_comments'
  | 'auto_replies'
  | 'suggestion_publish';

type PublicationPolicyRow = {
  publikEnabled: boolean;
  revision: number;
  updatedAt: Date;
} | null;

type PublisherSettingsRow = {
  chatCommentsEnabled: boolean;
  channelCommentsEnabled: boolean;
  channelSuggestionsEnabled: boolean;
  autoRepliesEnabled: boolean;
} | null;

type PublisherBindingRow = {
  publisherBotId: string;
  status: ChatBotMembershipStatus;
  lastWebhookAt: Date | null;
  permissionsSnapshot: unknown;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | null;
  botAccessExpiresAt: Date | null;
  sendRouteQuarantinedUntil: Date | null;
} | null;

export type PublisherReadinessSource = {
  id: string;
  entityType: ChatEntityType;
  publicationPolicy: PublicationPolicyRow;
  publisherSettings: PublisherSettingsRow;
  publisherBinding: PublisherBindingRow;
};

export type PublisherReadyRoute = {
  chatId: string;
  entityType: ManagedEntityType;
  requiredBotId: string;
  policyRevision: number;
};

const WRITE_PERMISSIONS = new Set([
  'write',
  'can_write',
  'post_edit_delete_message',
  'post_edit_delete_messages',
  'can_post_edit_delete_message',
  'can_post_edit_delete_messages',
]);

@Injectable()
export class PublisherReadinessService {
  private readonly logger = new Logger(PublisherReadinessService.name);
  private readonly publisherBotId: string;
  private readonly dispatchConfigured: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeHeartbeat: PublisherRuntimeHeartbeatReaderService,
    configService: ConfigService,
    @Optional() private readonly bindingRefreshQueue?: PublisherBindingRefreshQueueService,
  ) {
    const publisherBotId = resolveConfiguredPublisherBotId(configService);
    if (!publisherBotId) {
      throw new Error('MAX_PUBLISHER_BOT_ID is required for publisher readiness');
    }
    this.publisherBotId = publisherBotId;
    this.dispatchConfigured = configService.get<boolean>('MAX_PUBLISHER_DISPATCH_ENABLED', false);
  }

  async requestActorAccessRefresh(
    targets: readonly { chatId: string; entityType: ManagedEntityType }[],
    actorUserId: string,
    requiredBotId: string,
  ): Promise<void> {
    if (
      !this.dispatchConfigured ||
      !this.bindingRefreshQueue ||
      targets.length === 0 ||
      requiredBotId !== this.publisherBotId ||
      !actorUserId.trim()
    ) {
      return;
    }
    const now = new Date();
    // FLAG: Persisted publication targets may nominate a probe, never grant access. Respect fresh
    // denials and let the Publisher worker revalidate the exact bot/user under its lifecycle fence.
    const candidates = await this.prisma.chat.findMany({
      where: {
        OR: [...new Map(targets.map((target) => [target.chatId, target])).values()]
          .slice(0, MAX_PUBLICATION_TARGETS)
          .map((target) => ({
            id: target.chatId,
            entityType:
              target.entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
          })),
        publisherBinding: { is: publisherRefreshEvidenceWhere(this.publisherBotId) },
        accessEdges: {
          none: {
            userId: actorUserId,
            botId: this.publisherBotId,
            OR: [
              { expiresAt: { gt: now } },
              { expiresAt: null, checkedAt: { gt: new Date(now.getTime() - 15 * 60_000) } },
            ],
          },
        },
      },
      select: {
        id: true,
        entityType: true,
        accessEdges: {
          where: { userId: actorUserId, botId: this.publisherBotId },
          select: { sourceVersion: true },
          take: 1,
        },
      },
      take: MAX_PUBLICATION_TARGETS,
    });
    for (const candidate of candidates) {
      try {
        const existingEdge = candidate.accessEdges[0];
        const nomination = existingEdge
          ? { requestedAt: now, candidateVersion: existingEdge.sourceVersion ?? undefined }
          : await stageMissingPublicationActor(this.prisma, {
              chatId: candidate.id,
              entityType: candidate.entityType,
              userId: actorUserId,
              botId: this.publisherBotId,
            });
        if (!nomination) continue;
        await this.bindingRefreshQueue.enqueue({
          chatId: candidate.id,
          publisherBotId: this.publisherBotId,
          candidateUserId: actorUserId,
          reason: 'stale_user_access',
          ...nomination,
        });
      } catch (error: unknown) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to enqueue scheduled publication actor access refresh',
        );
        break;
      }
    }
  }

  resolvePolicy(row: PublicationPolicyRow): ManagedEntityPublicationPolicy {
    return {
      publikEnabled: row?.publikEnabled ?? true,
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  resolveReadiness(
    source: PublisherReadinessSource,
    options: { now?: Date; runtimeAvailable?: boolean; assumePolicyEnabled?: boolean } = {},
  ): PublisherEntityReadiness {
    const now = options.now ?? new Date();
    const policy = this.resolvePolicy(source.publicationPolicy);
    const binding = source.publisherBinding;
    const checkedAt = binding?.botAccessCheckedAt?.toISOString() ?? null;
    const base = {
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      checkedAt,
      retryAt: null,
    } as const;

    if (!policy.publikEnabled && options.assumePolicyEnabled !== true) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'disabled',
        blockerCode: 'policy_disabled',
      });
    }
    if (
      !binding ||
      binding.publisherBotId !== this.publisherBotId ||
      binding.status !== ChatBotMembershipStatus.ACTIVE
    ) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'setup_required',
        blockerCode: 'bot_not_connected',
      });
    }
    if (binding.sendRouteQuarantinedUntil && binding.sendRouteQuarantinedUntil > now) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'temporarily_unavailable',
        blockerCode: 'route_quarantined',
        retryAt: binding.sendRouteQuarantinedUntil.toISOString(),
      });
    }
    if (
      !binding.botAccessCheckedAt ||
      !binding.botAccessExpiresAt ||
      binding.botAccessExpiresAt <= now
    ) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'setup_required',
        blockerCode:
          binding.botAccessCheckedAt && binding.botAccessExpiresAt
            ? 'bot_access_expired'
            : 'bot_access_unconfirmed',
      });
    }
    if (
      binding.botAccessState === ChatBotAccessState.DENIED ||
      binding.botAccessState === ChatBotAccessState.LOST ||
      binding.botAccessState === ChatBotAccessState.CONFIRMED_MEMBER
    ) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'setup_required',
        blockerCode: 'bot_not_admin',
      });
    }
    if (
      binding.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      binding.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
    ) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'setup_required',
        blockerCode: 'bot_access_unconfirmed',
      });
    }

    const snapshot = normalizeMembershipAccessSnapshot(binding.permissionsSnapshot);
    const isOwner = binding.botAccessState === ChatBotAccessState.CONFIRMED_OWNER;
    if (!snapshot && !isOwner) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'setup_required',
        blockerCode: 'bot_access_unconfirmed',
      });
    }
    const permissionsKnown = Boolean(
      binding.permissionsSnapshot &&
      typeof binding.permissionsSnapshot === 'object' &&
      !Array.isArray(binding.permissionsSnapshot) &&
      (binding.permissionsSnapshot as Record<string, unknown>).permissionsKnown === true,
    );
    if (!isOwner && !permissionsKnown) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'setup_required',
        blockerCode: 'bot_access_unconfirmed',
      });
    }
    const permissions = new Set(
      (snapshot?.permissions ?? []).map((permission) => normalizePermissionName(permission)),
    );
    if (!isOwner && ![...WRITE_PERMISSIONS].some((permission) => permissions.has(permission))) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'setup_required',
        blockerCode: 'write_permission_missing',
      });
    }

    if (options.runtimeAvailable !== true) {
      return publisherEntityReadinessSchema.parse({
        ...base,
        state: 'temporarily_unavailable',
        blockerCode: 'publisher_runtime_unavailable',
      });
    }

    const isChat = source.entityType === ChatEntityType.CHAT;
    return publisherEntityReadinessSchema.parse({
      state: 'ready',
      canPublish: true,
      canUseChatComments: isChat && source.publisherSettings?.chatCommentsEnabled === true,
      canUseChannelComments: !isChat && source.publisherSettings?.channelCommentsEnabled === true,
      canPublishSuggestions:
        !isChat && source.publisherSettings?.channelSuggestionsEnabled === true,
      blockerCode: null,
      checkedAt,
      retryAt: null,
    });
  }

  async getEntityReadiness(chatId: string): Promise<{
    policy: ManagedEntityPublicationPolicy;
    readiness: PublisherEntityReadiness;
  }> {
    const source = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        entityType: true,
        publicationPolicy: true,
        publisherSettings: true,
        publisherBinding: true,
      },
    });
    if (!source) {
      throw new PublisherSetupRequiredException([chatId], 'bot_not_connected');
    }
    const runtimeAvailable = await this.isRuntimeAvailable();
    return {
      policy: this.resolvePolicy(source.publicationPolicy),
      readiness: this.resolveReadiness(source, { runtimeAvailable }),
    };
  }

  async assertEntityReady(chatId: string, feature: PublisherFeature): Promise<PublisherReadyRoute> {
    const source = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        entityType: true,
        publicationPolicy: true,
        publisherSettings: true,
        publisherBinding: true,
      },
    });
    if (!source) {
      throw new PublisherSetupRequiredException([chatId], 'bot_not_connected');
    }
    return this.assertSourceReady(source, feature, await this.isRuntimeAvailable());
  }

  async assertTargetsReady(
    targets: readonly { chatId: string; entityType: ManagedEntityType }[],
    feature: PublisherFeature = 'publication',
  ): Promise<PublisherReadyRoute[]> {
    const uniqueTargets = Array.from(
      new Map(
        targets.map((target) => [
          target.chatId.trim(),
          { ...target, chatId: target.chatId.trim() },
        ]),
      ).values(),
    ).filter((target) => target.chatId.length > 0);
    if (uniqueTargets.length === 0) {
      return [];
    }

    const [sources, runtimeAvailable] = await Promise.all([
      this.prisma.chat.findMany({
        where: { id: { in: uniqueTargets.map((target) => target.chatId) } },
        select: {
          id: true,
          entityType: true,
          publicationPolicy: true,
          publisherSettings: true,
          publisherBinding: true,
        },
      }),
      this.isRuntimeAvailable(),
    ]);
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const routes = uniqueTargets.map((target) => {
      const source = sourcesById.get(target.chatId);
      if (!source) {
        throw new PublisherSetupRequiredException([target.chatId], 'bot_not_connected');
      }
      return this.assertSourceReady(source, feature, runtimeAvailable);
    });
    const mismatched = routes.find(
      (route) =>
        uniqueTargets.find((target) => target.chatId === route.chatId)?.entityType !==
        route.entityType,
    );
    if (mismatched) {
      throw new PublisherSetupRequiredException([mismatched.chatId], 'bot_not_connected');
    }
    return routes;
  }

  private assertSourceReady(
    source: PublisherReadinessSource,
    feature: PublisherFeature,
    runtimeAvailable: boolean,
  ): PublisherReadyRoute {
    const policy = this.resolvePolicy(source.publicationPolicy);
    const readiness = this.resolveReadiness(source, { runtimeAvailable });
    const allowed =
      feature === 'chat_comments'
        ? readiness.canUseChatComments
        : feature === 'channel_comments'
          ? readiness.canUseChannelComments
          : feature === 'auto_replies'
            ? readiness.state === 'ready' &&
              source.entityType === ChatEntityType.CHAT &&
              source.publisherSettings?.autoRepliesEnabled === true
            : feature === 'suggestion_publish'
              ? readiness.canPublishSuggestions
              : readiness.canPublish;
    if (!allowed) {
      throw new PublisherSetupRequiredException(
        [source.id],
        readiness.blockerCode ?? 'module_disabled',
      );
    }
    return {
      chatId: source.id,
      entityType: source.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
      requiredBotId: this.publisherBotId,
      policyRevision: policy.revision,
    };
  }

  isRuntimeAvailable(): Promise<boolean> {
    if (!this.dispatchConfigured) {
      return Promise.resolve(false);
    }
    return this.runtimeHeartbeat
      .read(this.publisherBotId)
      .then((heartbeat) => heartbeat?.dispatchEnabled === true);
  }
}
