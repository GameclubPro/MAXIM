import type { MaxUpdate } from '@maxim/contracts';
import type { CommercialDeleteSettings } from './commercial-delete-binding';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { RuleViolation } from '../rule-engine.contract';
import { readExactDeleteOrigin } from '../webhook-effect-origin-context';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { CommercialLlmEnforcementMailbox } from './commercial-llm-enforcement.mailbox';
import {
  buildCommercialLlmOffer,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';

@Injectable()
export class CommercialLlmEnforcementService implements OnModuleDestroy {
  private readonly logger = new Logger(CommercialLlmEnforcementService.name);
  private redis: Redis | null = null;
  private connecting: Promise<CommercialLlmEnforcementMailbox> | null = null;
  private offering = false;
  private lastLog = 0;
  private readonly counts = { offered: 0, accepted: 0, skipped: 0, unavailable: 0 };
  constructor(private readonly config: ConfigService) {}

  enabled(): boolean {
    return this.config.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED', false) === true;
  }

  evaluate(
    violations: RuleViolation[],
    update: MaxUpdate,
    settings: CommercialDeleteSettings,
    protectedAuthor: boolean,
  ): RuleViolation[] {
    const routed = routeCommercialAiViolations(violations, this.enabled());
    const message = update.message;
    if (
      message &&
      update.eventTimestampSource === 'payload' &&
      !protectedAuthor &&
      routed.length === 0
    )
      this.offer({
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.senderId,
        text: message.text,
        eventAt: message.createdAt,
        settings,
      });
    return routed;
  }

  async mailbox(): Promise<CommercialLlmEnforcementMailbox> {
    if (!this.enabled()) throw new Error('Commercial AI enforcement disabled');
    if (this.redis?.status === 'ready') return new CommercialLlmEnforcementMailbox(this.redis);
    if (this.connecting) return this.connecting;
    this.redis?.disconnect();
    const redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
    this.redis = redis;
    this.connecting = redis.connect().then(() => new CommercialLlmEnforcementMailbox(redis));
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  // FLAG: Optional bounded handoff, never awaited by ordinary moderation. At most one local
  // admission is in flight; dependency loss neither queues work nor retries the original handler.
  offer(input: Parameters<typeof buildCommercialLlmOffer>[0]): void {
    if (!this.enabled()) return;
    this.counts.offered += 1;
    const origin = readExactDeleteOrigin(input.chatId, input.messageId);
    const offer = origin
      ? buildCommercialLlmOffer({
          ...input,
          originBotId: origin.sourceExecutionBotId,
          eventAt: origin.sourceEventAt.toISOString(),
          origin: {
            sourceWebhookEventId: origin.sourceWebhookEventId,
            sourceReceivingBotId: origin.sourceReceivingBotId,
            sourceExecutionBotId: origin.sourceExecutionBotId,
            sourceEventAtMs: origin.sourceEventAt.getTime(),
            sourceEvidenceVersion: 1,
          },
        })
      : null;
    if (this.offering || !offer) {
      this.counts.skipped += 1;
      this.logCounts();
      return;
    }
    this.offering = true;
    void this.mailbox()
      .then((mailbox) => mailbox.offer(offer))
      .then((accepted) => {
        this.counts[accepted ? 'accepted' : 'skipped'] += 1;
      })
      .catch(() => {
        this.counts.unavailable += 1;
      })
      .finally(() => {
        this.offering = false;
        this.logCounts();
      });
  }

  async hasProof(source: CommercialLlmSource): Promise<boolean> {
    return this.enabled() && (await (await this.mailbox()).hasProof(source));
  }

  private logCounts() {
    if (Date.now() - this.lastLog < 30_000) return;
    this.lastLog = Date.now();
    this.logger.log(
      { stage: 'commercial-ai-admission', ...this.counts },
      'Commercial AI admission totals',
    );
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}

// FLAG: AI mode replaces only commercial decisions. Other violations keep their order and authority.
export function routeCommercialAiViolations(
  violations: RuleViolation[],
  enabled: boolean,
): RuleViolation[] {
  return enabled
    ? violations.filter((violation) => violation.ruleCode !== 'COMMERCIAL_AD')
    : violations;
}
