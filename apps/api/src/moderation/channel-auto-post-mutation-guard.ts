import { BadRequestException } from '@nestjs/common';

import {
  hasConfirmedDeleteMessageAccess,
  hasConfirmedEditMessageAccess,
} from '../max/max-delete-message-access.util';
import {
  normalizePermissionName,
  type MembershipAccessSnapshot,
} from '../max/max-bot-access-policy.util';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
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
  resolveExecutableBotIdentity: (
    botId: string,
  ) => { id?: unknown; contactId?: unknown } | null;
};

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

function hasConfirmedChannelWriteMessageAccess(
  snapshot: MembershipAccessSnapshot | null,
): boolean {
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
