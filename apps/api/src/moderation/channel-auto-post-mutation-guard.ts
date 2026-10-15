import { BadRequestException } from '@nestjs/common';
import { extractHttpStatusCode } from '../common/http-error.util';
import { isAmbiguousMaxMutationError } from '../max/max-send-ambiguity.util';
import { wasMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';

import {
  hasConfirmedDeleteMessageAccess,
  hasConfirmedEditMessageAccess,
} from '../max/max-delete-message-access.util';
import {
  normalizePermissionName,
  type MembershipAccessSnapshot,
} from '../max/max-bot-access-policy.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxApiInternalRateLimitError,
  type MaxClientService,
} from '../max/max-client.service';
import { ChatEntityType } from '../prisma/prisma-client';
import { resolveChannelAutoPostMutationBotRoute } from './channel-auto-post-runtime';

const CHANNEL_AUTO_POST_MUTATION_GUARD_TIMEOUT_MS = 2_000;
const CHANNEL_WRITE_MESSAGE_PERMISSION_ALIASES = new Set([
  'write',
  'can_write',
  'post_edit_delete_message',
  'post_edit_delete_messages',
  'can_post_edit_delete_message',
  'can_post_edit_delete_messages',
]);

type ChannelAutoPostMutationAction = 'delete_message' | 'edit_message';

type ChannelAutoPostMutationGuardDependencies = {
  maxClient: Pick<
    MaxClientService,
    'getChatMemberAccess' | 'getChatSnapshot' | 'getCurrentChatMemberAccess'
  >;
  isCurrentChannelEntity: (chatId: string) => Promise<boolean>;
  resolveActionCandidateBotIds: (params: {
    chatId: string;
    action: ChannelAutoPostMutationAction;
  }) => Promise<readonly (string | null)[]>;
  resolveExecutableBotIdentity: (botId: string) => { id?: unknown; contactId?: unknown } | null;
};

type ChannelRouteReadWait = Readonly<{ chatId: string; botId: string }>;
const routeReadWaits = new WeakMap<object, ChannelRouteReadWait>();

export function readChannelRouteReadWait(
  error: unknown,
  chatId: string,
): ChannelRouteReadWait | null {
  if (!isInitialChannelReadQuotaRefusal(error)) return null;
  const proof = routeReadWaits.get(error);
  return proof?.chatId === chatId ? proof : null;
}

function isInitialChannelReadQuotaRefusal(error: unknown): error is MaxApiInternalRateLimitError {
  const evidence = error as { response?: unknown; config?: { method?: unknown } } | null;
  return (
    error instanceof MaxApiInternalRateLimitError &&
    error.preDispatch === true &&
    extractHttpStatusCode(error) === null &&
    evidence?.response == null &&
    (evidence?.config?.method === undefined || evidence.config.method === 'get') &&
    !wasMaxMessageSendAttempted(error) &&
    !wasMaxMemberMutationAttempted(error) &&
    !isAmbiguousMaxMutationError(error)
  );
}

export async function resolveInitialChannelMutationRoute(
  resolve: () => Promise<{ botId: string | null; requiredAuthorVerified: boolean }>,
  params: {
    chatId: string;
    source: 'webhook' | 'poll';
    linkType: string | null;
    quickButtons?: unknown;
  },
) {
  try {
    return { ...(await resolve()), routeReadFailure: null as unknown };
  } catch (error) {
    const wait = readChannelRouteReadWait(error, params.chatId);
    // FLAG: Direct webhook edits may persist a refused read, never infer bot rights.
    // Forwards, quick buttons and unmarked/attempted failures keep their original fences.
    if (
      !wait ||
      params.source !== 'webhook' ||
      params.linkType === 'forward' ||
      params.quickButtons
    )
      throw error;
    return { botId: wait.botId, requiredAuthorVerified: true, routeReadFailure: error };
  }
}

export class ChannelAutoPostMutationGuard {
  constructor(private readonly dependencies: ChannelAutoPostMutationGuardDependencies) {}

  async resolveMutationBotRoute(params: {
    chatId: string;
    action: ChannelAutoPostMutationAction;
    requiredAuthorUserId?: string | null;
  }): Promise<{ botId: string | null; requiredAuthorVerified: boolean }> {
    const actionCandidates = await this.dependencies.resolveActionCandidateBotIds(params);
    let firstAccessProbeError: unknown = null;

    for (const actionCandidateBotId of actionCandidates) {
      const candidateRoute = await resolveChannelAutoPostMutationBotRoute({
        actionCandidateBotIds: [actionCandidateBotId],
        requiredAuthorUserId: params.requiredAuthorUserId,
        resolveExecutableBotIdentity: (botId) => this.resolveExecutableBotIdentity(botId),
      });
      if (!candidateRoute.botId || !candidateRoute.requiredAuthorVerified) {
        continue;
      }

      try {
        const access = await this.getCurrentChannelBotAccessSnapshot(
          params.chatId,
          candidateRoute.botId,
        );
        const hasRequiredAccess =
          params.action === 'delete_message'
            ? hasConfirmedDeleteMessageAccess(access, ChatEntityType.CHANNEL) &&
              hasConfirmedChannelWriteMessageAccess(access)
            : hasConfirmedEditMessageAccess(access, ChatEntityType.CHANNEL);
        if (hasRequiredAccess) {
          return candidateRoute;
        }
      } catch (error: unknown) {
        // FLAG: Only this exact candidate's initial GET may nominate a durable edit wait.
        // It grants no access or mutation authority; final recovery must recheck both.
        if (
          params.action === 'edit_message' &&
          isInitialChannelReadQuotaRefusal(error) &&
          !routeReadWaits.has(error)
        )
          routeReadWaits.set(
            error,
            Object.freeze({ chatId: params.chatId, botId: candidateRoute.botId }),
          );
        firstAccessProbeError ??= error;
      }
    }

    if (firstAccessProbeError) {
      throw firstAccessProbeError;
    }
    return { botId: null, requiredAuthorVerified: false };
  }

  async assertEditAuthorized(chatId: string, botId: string): Promise<void> {
    await this.assertCurrentMutationTarget(chatId, botId);
    const botAccess = await this.getCurrentChannelBotAccessSnapshot(chatId, botId);
    if (!hasConfirmedEditMessageAccess(botAccess, ChatEntityType.CHANNEL)) {
      throw new BadRequestException(
        `Channel auto-post edit rejected because ${botId} cannot edit channel messages in ${chatId}`,
      );
    }
  }

  async assertForwardSendAuthorized(
    chatId: string,
    senderId: string | null,
    botId: string,
  ): Promise<void> {
    await this.assertCurrentMutationTarget(chatId, botId);
    const botAccess = await this.getCurrentChannelBotAccessSnapshot(chatId, botId);
    if (!hasConfirmedDeleteMessageAccess(botAccess, ChatEntityType.CHANNEL)) {
      throw new BadRequestException(
        `Channel auto-post replacement rejected because ${botId} cannot delete channel messages in ${chatId}`,
      );
    }
    if (!hasConfirmedChannelWriteMessageAccess(botAccess)) {
      throw new BadRequestException(
        `Channel auto-post replacement rejected because ${botId} cannot publish channel messages in ${chatId}`,
      );
    }
    await this.assertForwardSenderAuthorized(chatId, senderId, botId);
  }

  async assertForwardDeleteAuthorized(
    chatId: string,
    senderId: string | null,
    botId: string,
  ): Promise<void> {
    await this.assertCurrentMutationTarget(chatId, botId);
    const botAccess = await this.getCurrentChannelBotAccessSnapshot(chatId, botId);
    if (!hasConfirmedDeleteMessageAccess(botAccess, ChatEntityType.CHANNEL)) {
      throw new BadRequestException(
        `Channel auto-post cleanup rejected because ${botId} cannot delete channel messages in ${chatId}`,
      );
    }
    await this.assertForwardSenderAuthorized(chatId, senderId, botId);
  }

  private resolveExecutableBotIdentity(
    botId: string,
  ): { botId: string; contactId: string | null } | null {
    const identity = this.dependencies.resolveExecutableBotIdentity(botId);
    const executableBotId = readTrimmedString(identity?.id);
    if (!executableBotId) {
      return null;
    }
    return {
      botId: executableBotId,
      contactId: readTrimmedString(identity?.contactId),
    };
  }

  private async assertCurrentMutationTarget(chatId: string, botId: string): Promise<void> {
    if (!(await this.dependencies.isCurrentChannelEntity(chatId))) {
      throw new BadRequestException(
        `Channel auto-post mutation rejected because ${chatId} is not a channel`,
      );
    }
    const snapshot = await this.dependencies.maxClient.getChatSnapshot(chatId, {
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      timeoutMs: CHANNEL_AUTO_POST_MUTATION_GUARD_TIMEOUT_MS,
      botId,
    });
    if (snapshot.entityType !== 'channel') {
      throw new BadRequestException(
        `Channel auto-post mutation rejected because MAX classifies ${chatId} as ${snapshot.entityType}`,
      );
    }
  }

  private async getCurrentChannelBotAccessSnapshot(
    chatId: string,
    botId: string,
  ): Promise<MembershipAccessSnapshot> {
    const access = await this.dependencies.maxClient.getCurrentChatMemberAccess(chatId, {
      botId,
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      timeoutMs: CHANNEL_AUTO_POST_MUTATION_GUARD_TIMEOUT_MS,
    });
    return {
      checkedAt: null,
      isAdmin: access.isAdmin,
      isOwner: access.isOwner,
      permissions: [...access.permissions],
    };
  }

  private async assertForwardSenderAuthorized(
    chatId: string,
    senderId: string | null,
    botId: string,
  ): Promise<void> {
    if (!senderId) {
      throw new BadRequestException(
        `Channel auto-post replacement rejected because ${chatId} has no verified sender`,
      );
    }
    const access = await this.dependencies.maxClient.getChatMemberAccess(chatId, senderId, {
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      timeoutMs: CHANNEL_AUTO_POST_MUTATION_GUARD_TIMEOUT_MS,
      botId,
    });
    if (access?.isAdmin !== true && access?.isOwner !== true) {
      throw new BadRequestException(
        `Channel auto-post replacement rejected because ${senderId} is not a current admin of ${chatId}`,
      );
    }
  }
}

function hasConfirmedChannelWriteMessageAccess(snapshot: MembershipAccessSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }
  if (snapshot.isOwner) {
    return true;
  }
  if (!snapshot.isAdmin) {
    return false;
  }

  return snapshot.permissions.some((permission) =>
    CHANNEL_WRITE_MESSAGE_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
  );
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
