import {
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { Prisma, type SuggestionSubscriptionWatch } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSuggestionAdminQueueService } from '../publisher/publisher-suggestion-admin.queue';

export const SUGGESTION_SUBSCRIPTION_DELETE_RULE = 'SUGGESTION_AUTHOR_UNSUBSCRIBED';
export const SUGGESTION_SUBSCRIPTION_CONFIRM_MS = 30_000;
export const SUGGESTION_SUBSCRIPTION_INTERVAL_MS = 6 * 60 * 60_000;
export type SuggestionProfile = 'moderation' | 'publisher';
export class SuggestionDeletionCancelledError extends Error {}
export type SuggestionDeletionProof = {
  id: string;
  watchId: string;
  revision: number;
  checkedAt: number;
  chatId: string;
  messageId: string;
  botId: string;
};

@Injectable()
export class SuggestionSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotRegistryService,
    private readonly links: MaxBotLinkService,
    @Optional() private readonly publisherQueue?: PublisherSuggestionAdminQueueService,
  ) {}

  async policy(
    chatId: string,
    profile: SuggestionProfile,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    if (profile === 'publisher') {
      const row = await db.publisherEntitySettings.findUnique({
        where: { chatId },
        select: {
          channelSuggestionsRequireSubscription: true,
          channelSuggestionsDeleteOnUnsubscribe: true,
        },
      });
      return {
        required: row?.channelSuggestionsRequireSubscription === true,
        deleteOnLeave: row?.channelSuggestionsDeleteOnUnsubscribe === true,
      };
    }
    const row = await db.channelSettings.findUnique({
      where: { chatId },
      select: {
        postSuggestionsRequireSubscription: true,
        postSuggestionsDeleteOnUnsubscribe: true,
      },
    });
    return {
      required: row?.postSuggestionsRequireSubscription === true,
      deleteOnLeave: row?.postSuggestionsDeleteOnUnsubscribe === true,
    };
  }

  async assertCanSubmit(chatId: string, userId: string, profile: SuggestionProfile): Promise<void> {
    if (!(await this.policy(chatId, profile)).required) return;
    let member: boolean;
    try {
      if (profile === 'publisher') {
        const botId = this.bots.getPublisherBotDescriptor().id;
        if (this.bots.getBotById(botId)) {
          member = (await this.probe(chatId, [userId], botId, 'interactive')).has(userId);
        } else {
          if (!this.publisherQueue) throw new Error('Publisher subscription worker unavailable');
          member = await this.publisherQueue.checkSubscription(chatId, userId, botId);
        }
      } else {
        const route = await this.links.resolveBotRoute({ chatId, purpose: 'member_access' });
        if (!route.botId) throw new Error('Membership route unavailable');
        member = (await this.probe(chatId, [userId], route.botId, 'interactive')).has(userId);
      }
    } catch {
      throw new ServiceUnavailableException(
        'Не удалось проверить подписку. Повторите отправку позже.',
      );
    }
    if (!member)
      throw new ForbiddenException({
        code: 'SUGGESTION_SUBSCRIPTION_REQUIRED',
        message: 'Чтобы предложить пост, подпишитесь на канал и повторите отправку.',
      });
  }

  async probe(
    chatId: string,
    userIds: string[],
    botId: string,
    trafficClass: 'interactive' | 'background',
  ) {
    return this.max.getChatMembersAccess(chatId, userIds, {
      botId,
      trafficClass,
      sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      bypassCache: true,
      timeoutMs: 3_000,
    });
  }

  async track(
    input: {
      id: string;
      chatId: string;
      authorUserId: string;
      profile: SuggestionProfile;
      botId: string;
      messageId?: string;
      publicationId?: string;
    },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    // FLAG: Opt in at publication time. Never discover/delete historical channel posts.
    if (!(await this.policy(input.chatId, input.profile, db)).deleteOnLeave) return;
    const watchId = createHash('sha256')
      .update(JSON.stringify([input.chatId, input.authorUserId, input.profile, input.botId]))
      .digest('hex');
    const existing = await db.suggestionSubscriptionPublication.findUnique({
      where: { id: input.id },
      select: { id: true },
    });
    if (existing) return;
    await db.suggestionSubscriptionWatch.upsert({
      where: { id: watchId },
      create: {
        id: watchId,
        chatId: input.chatId,
        authorUserId: input.authorUserId,
        profile: input.profile,
        botId: input.botId,
      },
      update: {
        nextCheckAt: new Date(),
        checkedAt: null,
        missingSince: null,
        revision: { increment: 1 },
      },
    });
    await db.suggestionSubscriptionPublication.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        watchId,
        messageId: input.messageId,
        publicationId: input.publicationId,
      },
      update: {},
    });
  }

  async wake(chatId: string, userIds: readonly string[]): Promise<void> {
    // Each exact author prefix covers only its configured bot/profile watches, never channel history.
    for (const authorUserId of new Set(userIds)) {
      await this.prisma.suggestionSubscriptionWatch.updateMany({
        where: { chatId, authorUserId },
        data: {
          nextCheckAt: new Date(),
          missingSince: null,
          checkedAt: null,
          revision: { increment: 1 },
        },
      });
    }
  }

  async prepareDeletion(id: string, botId: string): Promise<SuggestionDeletionProof> {
    const row = await this.prisma.suggestionSubscriptionPublication.findUnique({
      where: { id },
      include: { watch: true },
    });
    if (!row || row.deletedAt || !row.messageId || row.watch.botId !== botId)
      throw new Error('Suggestion source unavailable');
    const watch = row.watch;
    if (
      !watch.missingSince ||
      Date.now() - watch.missingSince.getTime() < SUGGESTION_SUBSCRIPTION_CONFIRM_MS
    ) {
      throw new SuggestionDeletionCancelledError('Subscription absence not confirmed');
    }
    if (!(await this.policy(watch.chatId, this.profile(watch))).deleteOnLeave)
      throw new SuggestionDeletionCancelledError('Suggestion deletion disabled');
    // Reuse only a recent, uncached, successful targeted probe. Unknown never authorizes deletion.
    if (!watch.checkedAt || Date.now() - watch.checkedAt.getTime() > 10_000) {
      const checkedAt = new Date();
      const members = await this.probe(watch.chatId, [watch.authorUserId], botId, 'background');
      const member = members.has(watch.authorUserId);
      const changed = await this.prisma.suggestionSubscriptionWatch.updateMany({
        where: { id: watch.id, revision: watch.revision },
        data: { checkedAt, ...(member ? { missingSince: null, revision: { increment: 1 } } : {}) },
      });
      if (!changed.count || member)
        throw new SuggestionDeletionCancelledError('Author subscription changed');
      watch.checkedAt = checkedAt;
    }
    const proof = {
      id,
      watchId: watch.id,
      revision: watch.revision,
      checkedAt: watch.checkedAt.getTime(),
      chatId: watch.chatId,
      messageId: row.messageId,
      botId,
    };
    await this.assertDeletionAllowed(proof);
    return proof;
  }

  async assertDeletionAllowed(proof: SuggestionDeletionProof): Promise<void> {
    // FLAG: No MAX call inside the DELETE transport slot. Revalidate exact SQL authority and epoch.
    if (Date.now() - proof.checkedAt > 30_000) throw new Error('Subscription proof expired');
    const row = await this.prisma.suggestionSubscriptionPublication.findUnique({
      where: { id: proof.id },
      include: { watch: true },
    });
    if (
      !row ||
      row.deletedAt ||
      row.watchId !== proof.watchId ||
      row.messageId !== proof.messageId ||
      row.watch.chatId !== proof.chatId ||
      row.watch.botId !== proof.botId ||
      row.watch.revision !== proof.revision ||
      !row.watch.missingSince ||
      !(await this.policy(row.watch.chatId, this.profile(row.watch))).deleteOnLeave
    ) {
      throw new SuggestionDeletionCancelledError('Suggestion deletion no longer authorized');
    }
  }

  profile(watch: Pick<SuggestionSubscriptionWatch, 'profile'>): SuggestionProfile {
    if (watch.profile !== 'publisher' && watch.profile !== 'moderation')
      throw new Error('Invalid suggestion profile');
    return watch.profile;
  }
}
