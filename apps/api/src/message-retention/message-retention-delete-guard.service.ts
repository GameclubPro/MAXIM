import { Injectable } from '@nestjs/common';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { MessageRetentionStore } from './message-retention-store.service';
import { retentionBindingQuery, type RetentionBindingRow } from './message-retention-binding';

export type MessageRetentionGuardReason =
  | 'protected_author'
  | 'pinned'
  | 'activation_ended'
  | 'runtime_disabled'
  | 'author_unknown'
  | 'evidence_expired'
  | 'policy_changed'
  | 'identity_changed'
  | 'not_due'
  | 'ownership_changed'
  | 'capacity_paused'
  | 'candidate_inactive'
  | 'entity_ineligible';

export class MessageRetentionGuardError extends Error {
  readonly code = 'message_retention_guard_rejected';
  constructor(
    readonly disposition: 'skip' | 'retry',
    message: string,
    readonly reasonCode?: MessageRetentionGuardReason,
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

  async assertAllowed(
    intentId: string,
    botId: string,
    phase: 'prepare' | 'dispatch' = 'prepare',
  ): Promise<void> {
    const binding = await this.loadBinding(intentId);
    const { candidate, policy } = binding;
    const decision = await this.governor.decide({
      component: 'message-retention',
      sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
    });
    if (decision.action === 'pause')
      this.retry('Background capacity unavailable', 'capacity_paused');
    const options = this.options(botId);
    const cacheKey = `${botId}:${candidate.chatId}`;
    let author = this.authors.get(`${cacheKey}:${candidate.authorId}`);
    if (!author || Date.now() - author.at >= 30_000) {
      if (phase === 'dispatch')
        this.retry('Author verification expired while waiting for dispatch', 'evidence_expired');
      const nextAuthors = await this.prisma.messageRetentionCandidate.findMany({
        where: {
          chatId: candidate.chatId,
          status: 'pending',
          sourceAt: { lte: new Date(Date.now() - policy.hours * 3_600_000) },
        },
        orderBy: [{ sourceAt: 'asc' }, { messageId: 'asc' }],
        take: 4,
        select: { authorId: true },
      });
      await this.primeAuthors(
        candidate.chatId,
        [candidate.authorId, ...nextAuthors.map((row) => row.authorId)],
        botId,
      );
      author = this.authors.get(`${cacheKey}:${candidate.authorId}`);
    }
    if (!author || Date.now() - author.at >= 30_000)
      this.retry('Author access is unknown', 'author_unknown');
    if (!author.allowed) this.skip('Protected author', 'protected_author');
    let pin = this.pins.get(cacheKey);
    if (!pin || Date.now() - pin.at >= 5_000) {
      if (phase === 'dispatch')
        this.retry('Pin verification expired while waiting for dispatch', 'evidence_expired');
      const startedAt = Date.now();
      const id = await this.max.getPinnedMessageId(candidate.chatId, options);
      pin = { id, at: startedAt };
      if (this.pins.size >= 256) this.pins.clear();
      this.pins.set(cacheKey, pin);
    }
    if (pin.id === candidate.messageId) this.skip('Pinned message', 'pinned');
    // FLAG: Re-read destructive authority after remote checks and limiter waits.
    const latest = await this.loadBinding(intentId);
    if (Date.now() - author.at >= 30_000 || Date.now() - pin.at >= 5_000)
      this.retry('Remote verification expired before dispatch', 'evidence_expired');
    if (
      latest.candidate.chatId !== candidate.chatId ||
      latest.candidate.messageId !== candidate.messageId ||
      latest.candidate.authorId !== candidate.authorId ||
      latest.candidate.activationId !== candidate.activationId ||
      latest.candidate.sourceAt.getTime() !== candidate.sourceAt.getTime()
    )
      this.retry('Candidate identity changed during verification', 'identity_changed');
    if (latest.policy.revision !== policy.revision)
      this.retry('Policy changed during verification', 'policy_changed');
  }

  async primeAuthors(chatId: string, authorIds: string[], botId: string): Promise<void> {
    const authors = [...new Set(authorIds)].slice(0, 5);
    // FLAG: Unknown refresh results must not revive previously allowed author evidence.
    for (const authorId of authors) this.authors.delete(`${botId}:${chatId}:${authorId}`);
    const startedAt = Date.now();
    const access = await this.max.getChatMembersAccess(chatId, authors, this.options(botId));
    if (this.authors.size >= 512) this.authors.clear();
    for (const authorId of authors) {
      const row = access.get(authorId);
      if (
        !row ||
        row.userId !== authorId ||
        typeof row.isAdmin !== 'boolean' ||
        typeof row.isOwner !== 'boolean' ||
        typeof row.isBot !== 'boolean'
      )
        continue;
      this.authors.set(`${botId}:${chatId}:${authorId}`, {
        at: startedAt,
        allowed:
          !row.isAdmin &&
          !row.isOwner &&
          row.isBot === false &&
          !this.bots.isKnownBotUserId(authorId),
      });
    }
  }

  private async loadBinding(intentId: string) {
    // FLAG: One statement reads a coherent destructive binding. Keep both reads around
    // remote preparation/final dispatch; a mixed reason or ownership transfer never authorizes retention.
    const [binding] = await this.prisma.$queryRaw<RetentionBindingRow[]>(
      retentionBindingQuery(intentId),
    );
    if (
      !binding ||
      binding.intentId !== intentId ||
      binding.retentionOwned !== true ||
      binding.reasonCount !== 1 ||
      binding.retentionReasonCount !== 1
    )
      this.retry('Retention intent ownership changed', 'ownership_changed');
    if (!this.store.allows(binding.chatId, true))
      this.retry('Retention execution disabled', 'runtime_disabled');
    if (
      binding.candidateMessageId !== binding.messageId ||
      binding.shadowOnly !== false ||
      binding.candidateIntentId !== intentId ||
      !binding.authorId ||
      !binding.activationId ||
      !binding.sourceAt ||
      !binding.status ||
      !['pending', 'retry'].includes(binding.status)
    )
      this.skip('Candidate is no longer pending', 'candidate_inactive');
    if (binding.enabled !== true || binding.policyActivationId !== binding.activationId)
      this.skip('Activation ended', 'activation_ended');
    const hours = binding.hours;
    const revision = binding.revision;
    if ((hours !== 24 && hours !== 48) || revision === null || !Number.isSafeInteger(revision))
      this.retry('Policy authority is invalid', 'policy_changed');
    if (binding.authorId !== binding.subjectUserId || this.bots.isKnownBotUserId(binding.authorId))
      this.skip('Protected author', 'protected_author');
    if (binding.sourceAt.getTime() + hours * 3_600_000 > Date.now())
      this.retry('Message is not old enough', 'not_due');
    if (binding.entityType !== 'CHAT')
      this.skip('Only group chats are eligible', 'entity_ineligible');
    const candidate = {
      chatId: binding.chatId,
      messageId: binding.messageId,
      authorId: binding.authorId,
      activationId: binding.activationId,
      sourceAt: binding.sourceAt,
    };
    const policy = { hours, revision };
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
  private retry(message: string, reasonCode: MessageRetentionGuardReason): never {
    throw new MessageRetentionGuardError('retry', message, reasonCode);
  }
  private skip(message: string, reasonCode: MessageRetentionGuardReason): never {
    throw new MessageRetentionGuardError('skip', message, reasonCode);
  }
}
