import type { MaxUpdate } from '@maxim/contracts';
import type { CommercialDeleteSettings } from './commercial-delete-binding';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { RuleViolation } from '../rule-engine.contract';
import { readExactDeleteOrigin } from '../webhook-effect-origin-context';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import {
  CommercialLlmEnforcementMailbox,
  type CommercialLlmAdmissionResult,
} from './commercial-llm-enforcement.mailbox';
import { resolveCommercialAiTriage } from './commercial-ai-triage';
import {
  buildCommercialLlmOffer,
  prepareCommercialLlmOffer,
  type CommercialLlmOfferRejection,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';

@Injectable()
export class CommercialLlmEnforcementService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(CommercialLlmEnforcementService.name);
  private redis: Redis | null = null;
  private connecting: Promise<CommercialLlmEnforcementMailbox> | null = null;
  private offering = false;
  private lastLog = 0;
  private readonly counts = {
    offered: 0,
    eligible: 0,
    ineligible: 0,
    accepted: 0,
    skipped: 0,
    unavailable: 0,
  };
  private readonly ineligibleReasons: Partial<Record<CommercialLlmOfferRejection, number>> = {};
  private readonly skipReasons: Partial<
    Record<Exclude<CommercialLlmAdmissionResult, 'accepted'> | 'producer_busy', number>
  > = {};
  private timer: NodeJS.Timeout | null = null;
  private readonly observationStartedAtMs = Date.now();
  private readonly windows = new Map<
    number,
    {
      offered: number;
      eligible: number;
      ineligible: number;
      accepted: number;
      skipped: number;
      unavailable: number;
    }
  >();
  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => this.logWindows(), 10_000);
    this.timer.unref();
  }

  private logWindows(): void {
    const now = Date.now();
    for (const [startedAt, counts] of this.windows) {
      const inFlight = counts.eligible - counts.accepted - counts.skipped - counts.unavailable;
      if (startedAt + 60_000 > now || inFlight !== 0) continue;
      this.logger.log(
        {
          stage: 'commercial-ai-admission-window',
          schemaVersion: 1,
          basis: 'offer_intake_minute',
          scope: 'settled_offers_observed_by_this_process',
          windowStartAt: new Date(startedAt).toISOString(),
          windowEndAt: new Date(startedAt + 60_000).toISOString(),
          observationStartedAt: new Date(this.observationStartedAtMs).toISOString(),
          observedFromAt: new Date(Math.max(startedAt, this.observationStartedAtMs)).toISOString(),
          intakeBoundaryObserved: this.observationStartedAtMs <= startedAt,
          fleetCoverage: 'not_established',
          windowSelection: 'nonempty_only',
          ...counts,
          inFlight,
          settled: true,
        },
        'Closed commercial AI admission window',
      );
      this.windows.delete(startedAt);
    }
  }

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
        triage: resolveCommercialAiTriage({ text: message.text, violations }),
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
  offer(
    input: Parameters<typeof buildCommercialLlmOffer>[0] & {
      triage?: ReturnType<typeof resolveCommercialAiTriage>;
    },
  ): void {
    if (!this.enabled()) return;
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    if (!this.windows.has(minute))
      this.windows.set(minute, {
        offered: 0,
        eligible: 0,
        ineligible: 0,
        accepted: 0,
        skipped: 0,
        unavailable: 0,
      });
    const window = this.windows.get(minute)!;
    this.counts.offered += 1;
    window.offered += 1;
    const origin = readExactDeleteOrigin(input.chatId, input.messageId);
    const prepared: ReturnType<typeof prepareCommercialLlmOffer> = origin
      ? prepareCommercialLlmOffer({
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
      : {
          reason: input.settings.commercialAdsFilterEnabled
            ? ('invalid_origin' as const)
            : ('filter_disabled' as const),
        };
    if (!prepared.offer) {
      this.counts.ineligible += 1;
      window.ineligible += 1;
      this.ineligibleReasons[prepared.reason] = (this.ineligibleReasons[prepared.reason] ?? 0) + 1;
      this.logCounts();
      return;
    }
    const offer = prepared.offer;
    this.counts.eligible += 1;
    window.eligible += 1;
    const trace = {
      traceId: offer.source.nonce,
      intakeWindowStartAt: new Date(minute).toISOString(),
    };
    if (this.offering) {
      this.counts.skipped += 1;
      window.skipped += 1;
      this.skipReasons.producer_busy = (this.skipReasons.producer_busy ?? 0) + 1;
      this.logger.log(
        { stage: 'commercial-ai-offer', ...trace, outcome: 'producer_busy' },
        'Commercial AI admission',
      );
      this.logCounts();
      return;
    }
    this.offering = true;
    void this.mailbox()
      .then((mailbox) => mailbox.offerDetailed(offer))
      .then((outcome) => {
        const accepted = outcome === 'accepted';
        this.counts[accepted ? 'accepted' : 'skipped'] += 1;
        window[accepted ? 'accepted' : 'skipped'] += 1;
        if (!accepted) this.skipReasons[outcome] = (this.skipReasons[outcome] ?? 0) + 1;
        this.logger.log(
          {
            stage: 'commercial-ai-offer',
            ...trace,
            outcome,
            triage: input.triage ?? resolveCommercialAiTriage({ text: input.text }),
          },
          'Commercial AI admission',
        );
      })
      .catch(() => {
        this.counts.unavailable += 1;
        window.unavailable += 1;
        this.logger.warn(
          { stage: 'commercial-ai-offer', ...trace, outcome: 'dependency_unavailable' },
          'Commercial AI admission unavailable',
        );
      })
      .finally(() => {
        this.offering = false;
        this.logCounts();
        this.logWindows();
      });
  }

  async hasProof(source: CommercialLlmSource): Promise<boolean> {
    return this.enabled() && (await (await this.mailbox()).hasProof(source));
  }

  private logCounts() {
    if (Date.now() - this.lastLog < 30_000) return;
    this.lastLog = Date.now();
    this.logger.log(
      {
        stage: 'commercial-ai-admission',
        schemaVersion: 3,
        ...this.counts,
        inFlight:
          this.counts.eligible -
          this.counts.accepted -
          this.counts.skipped -
          this.counts.unavailable,
        ineligibleReasons: { ...this.ineligibleReasons },
        skipReasons: { ...this.skipReasons },
      },
      'Commercial AI admission totals',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.logWindows();
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
