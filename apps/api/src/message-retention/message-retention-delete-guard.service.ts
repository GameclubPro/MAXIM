import { Injectable } from '@nestjs/common';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { MessageRetentionStore } from './message-retention-store.service';
import { MESSAGE_RETENTION_RULE } from './message-retention.policy';

export class MessageRetentionGuardError extends Error {
  readonly code = 'message_retention_guard_rejected';
  constructor(
    readonly disposition: 'skip' | 'retry',
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class MessageRetentionDeleteGuard {
  private readonly pins = new Map<string, { at: number; id: string | null }>();
  private readonly authors = new Map<string, { at: number; allowed: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MessageRetentionStore,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly governor: BackgroundRuntimeGovernorService,
  ) {}

  async assertAllowed(intentId: string, botId: string): Promise<void> {
    const binding = await this.loadBinding(intentId);
    const { candidate, policy } = binding;
    const decision = await this.governor.decide({
      component: 'message-retention',
      sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
    });
    if (decision.action === 'pause') this.retry('Background capacity unavailable');
    const options = this.options(botId);
    const cacheKey = `${botId}:${candidate.chatId}`;
    let author = this.authors.get(`${cacheKey}:${candidate.authorId}`);
    if (!author || Date.now() - author.at >= 30_000) {
      await this.primeAuthors(candidate.chatId, [candidate.authorId], botId);
      author = this.authors.get(`${cacheKey}:${candidate.authorId}`);
    }
    if (!author) this.retry('Author access is unknown');
    if (!author.allowed) this.skip('Protected author');
    let pin = this.pins.get(cacheKey);
    if (!pin || Date.now() - pin.at >= 5_000) {
      const id = await this.max.getPinnedMessageId(candidate.chatId, options);
      pin = { id, at: Date.now() };
      if (this.pins.size >= 256) this.pins.clear();
      this.pins.set(cacheKey, pin);
    }
    if (pin.id === candidate.messageId) this.skip('Pinned message');
    // FLAG: Re-read destructive authority after remote checks and limiter waits.
    const latest = await this.loadBinding(intentId);
    if (latest.policy.revision !== policy.revision)
      this.retry('Policy changed during verification');
  }

  async primeAuthors(chatId: string, authorIds: string[], botId: string): Promise<void> {
    const authors = [...new Set(authorIds)].slice(0, 5);
    const access = await this.max.getChatMembersAccess(chatId, authors, this.options(botId));
    if (this.authors.size >= 512) this.authors.clear();
    for (const authorId of authors) {
      const row = access.get(authorId);
      if (!row || row.userId !== authorId) continue;
      this.authors.set(`${botId}:${chatId}:${authorId}`, {
        at: Date.now(),
        allowed:
          !row.isAdmin &&
          !row.isOwner &&
          row.isBot !== true &&
          !this.bots.isKnownBotUserId(authorId),
      });
    }
  }

  private async loadBinding(intentId: string) {
    const intent = await this.prisma.moderationDeleteIntent.findUnique({
      where: { id: intentId },
      select: {
        retentionOwned: true,
        chatId: true,
        messageId: true,
        subjectUserId: true,
        reasons: { select: { ruleCode: true } },
      },
    });
    if (
      !intent?.retentionOwned ||
      intent.reasons.length !== 1 ||
      intent.reasons[0]?.ruleCode !== MESSAGE_RETENTION_RULE
    )
      this.retry('Retention intent ownership changed');
    if (!this.store.allows(intent.chatId, true)) this.retry('Retention execution disabled');
    const candidate = await this.prisma.messageRetentionCandidate.findUnique({
      where: {
        chatId_messageId: { chatId: intent.chatId, messageId: intent.messageId },
      },
      include: { policy: true },
    });
    if (
      !candidate ||
      candidate.shadowOnly ||
      candidate.intentId !== intentId ||
      !['pending', 'retry'].includes(candidate.status)
    )
      this.skip('Candidate is no longer pending');
    const policy = candidate.policy;
    if (!policy.enabled || policy.activationId !== candidate.activationId)
      this.skip('Activation ended');
    if (
      candidate.authorId !== intent.subjectUserId ||
      this.bots.isKnownBotUserId(candidate.authorId)
    )
      this.skip('Protected author');
    if (candidate.sourceAt.getTime() + policy.hours * 3_600_000 > Date.now())
      this.retry('Message is not old enough');
    const chat = await this.prisma.chat.findUnique({
      where: { id: intent.chatId },
      select: { entityType: true },
    });
    if (chat?.entityType !== 'CHAT') this.skip('Only group chats are eligible');
    return { candidate, policy };
  }

  private options(
    botId: string,
  ): NonNullable<Parameters<MaxClientService['getChatMembersAccess']>[2]> {
    return {
      botId,
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
      timeoutMs: 5_000,
    };
  }
  private retry(message: string): never {
    throw new MessageRetentionGuardError('retry', message);
  }
  private skip(message: string): never {
    throw new MessageRetentionGuardError('skip', message);
  }
}
