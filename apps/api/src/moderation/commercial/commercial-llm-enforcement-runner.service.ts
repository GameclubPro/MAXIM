import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import { CommercialLlmCascadeClient } from './commercial-llm-cascade.client';
import { CommercialLlmClient, CommercialLlmError } from './commercial-llm.client';
import type { CommercialLlmClassifier } from './commercial-llm.protocol';
import { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import { CommercialLlmShadowLease, createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { commercialLlmHostHasHeadroom } from './commercial-llm-shadow.processor';
import { COMMERCIAL_LLM_ENFORCEMENT_KEYS } from './commercial-llm-enforcement.mailbox';
import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';

@Injectable()
export class CommercialLlmEnforcementRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommercialLlmEnforcementRunnerService.name);
  private readonly worker = randomUUID();
  private readonly controller = new AbortController();
  private redis: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private readonly active = new Set<Promise<void>>();
  private secondary: CommercialLlmSecondaryScheduler | null = null;
  private lastSuccessAt: string | null = null;
  private lastStatusAt = 0;
  private lastFailureAt = 0;
  private readonly outcomes: Record<string, number> = {};
  constructor(
    private readonly config: ConfigService,
    private readonly admission: CommercialLlmEnforcementService,
    private readonly governor: BackgroundRuntimeGovernorService,
    private readonly intents: ModerationDeleteIntentService,
  ) {}

  onModuleInit(): void {
    if (
      !this.admission.enabled() ||
      this.config.get<string>('APP_SERVICE_NAME') !== 'api-moderation-background'
    )
      return;
    this.timer = setInterval(() => this.wake(), 250);
    this.timer.unref();
  }

  private wake(): void {
    if (this.polling || this.controller.signal.aborted) return;
    this.polling = this.poll()
      .catch(() => this.logDependencyFailure())
      .finally(() => {
        this.polling = null;
      });
  }

  private logDependencyFailure(): void {
    if (Date.now() - this.lastFailureAt < 10_000) return;
    this.lastFailureAt = Date.now();
    this.logger.warn(
      { stage: 'commercial-ai-worker', outcome: 'dependency_unavailable' },
      'Commercial AI poll unavailable',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.polling;
    // FLAG: Drain actual work before closing Redis; a stopped poll never releases an unfinished model lease.
    await Promise.allSettled([...this.active]);
    await this.admission
      .mailbox()
      .then((mailbox) => mailbox.withdraw(this.worker))
      .catch(() => undefined);
    this.redis?.disconnect();
  }

  private async mayRun(): Promise<boolean> {
    const decision = await this.governor.decide({
      component: 'commercial-llm-shadow',
      sourceTag: 'commercial-llm-shadow',
    });
    return decision.action === 'run' && (await commercialLlmHostHasHeadroom());
  }

  private async writeStatus(outcome = 'idle'): Promise<void> {
    if (!this.redis) return;
    this.lastStatusAt = Date.now();
    const pendingDiscards = await (await this.admission.mailbox()).readObservations();
    const status = {
      stage: 'commercial-ai',
      schemaVersion: 2,
      mode: 'ENFORCE',
      heartbeatAt: new Date().toISOString(),
      lastSuccessAt: this.lastSuccessAt,
      outcome: this.active.size > 0 ? 'active' : outcome,
      active: this.active.size,
      outcomeBasis: 'process_cumulative',
      outcomes: { ...this.outcomes },
      pendingDiscardBasis: 'redis_namespace_cumulative',
      pendingDiscards,
    };
    await this.redis.set(COMMERCIAL_LLM_ENFORCEMENT_KEYS.status, JSON.stringify(status), 'EX', 30);
    this.logger.log(
      { ...status, stage: 'commercial-ai-cumulative' },
      'Commercial AI cumulative results',
    );
  }

  private async poll(): Promise<void> {
    const mailbox = await this.admission.mailbox();
    if (!(await mailbox.heartbeat(this.worker)) || this.controller.signal.aborted) return;
    if (!this.redis || this.redis.status !== 'ready') {
      this.redis?.disconnect();
      this.redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
      await this.redis.connect();
      const client = new CommercialLlmClient({
        endpoint: this.config.getOrThrow<string>('COMMERCIAL_LLM_ENDPOINT'),
      });
      this.secondary = new CommercialLlmSecondaryScheduler(
        new CommercialLlmShadowLease(this.redis),
        client,
        (outcome, waitMs) =>
          this.logger.log(
            { stage: 'commercial-ai-secondary', outcome, waitMs },
            'Commercial AI confirmation admission',
          ),
      );
    }
    if (Date.now() - this.lastStatusAt >= 10_000) await this.writeStatus();
    if (!(await this.mayRun())) {
      await mailbox.withdraw(this.worker);
      return;
    }
    await mailbox.advertise(this.worker);
    // FLAG: At most primary running + secondary running + one waiting confirmation, plus one pending input.
    if (this.active.size >= 3) return;
    const redis = this.redis;
    const secondary = this.secondary!;
    const processor = new CommercialLlmEnforcementProcessor(
      mailbox,
      ({ raw, request, deadlineAtMs }) => {
        const trace = { traceId: request.source.nonce, admittedAtMs: request.submittedAtMs };
        const primary = new CommercialLlmWorkstationMailbox(redis);
        // FLAG: Both confirmation paths reserve the chat in Redis before server admission.
        // Releasing this claim never releases the exact active source or its DELETE proof.
        const withSecondary = async (
          classify: () => ReturnType<CommercialLlmClassifier['classify']>,
        ) => {
          if (!(await mailbox.claimSecondary(raw, this.worker)))
            throw new CommercialLlmError('BUSY');
          try {
            return await classify();
          } finally {
            await mailbox.releaseSecondary(raw, this.worker).catch(() => undefined);
          }
        };
        return new CommercialLlmCascadeClient(
          {
            classify: async (excerpt, signal) => {
              const result = await primary.classify(excerpt, signal);
              this.logger.log(
                {
                  stage: 'commercial-ai-primary',
                  ...trace,
                  outcome: result.outcome,
                  ...(result.outcome === 'COMPLETE'
                    ? { durationMs: result.result.durationMs }
                    : {}),
                },
                'Commercial AI primary result',
              );
              return result;
            },
          },
          {
            classify: (excerpt, signal, valid) =>
              withSecondary(() =>
                secondary.classifyWithin(excerpt, deadlineAtMs, signal, valid, (outcome, waitMs) =>
                  this.logger.log(
                    { stage: 'commercial-ai-secondary', ...trace, outcome, waitMs },
                    'Commercial AI confirmation admission',
                  ),
                ),
              ),
          },
          () => this.mayRun(),
          undefined,
          async () => {
            await mailbox.releasePrimary(raw, this.worker);
            this.wake();
          },
          // Audit negatives never occupy the one waiting slot needed by an actionable confirmation.
          {
            classify: (excerpt, signal, valid) =>
              withSecondary(() => secondary.classifyAudit(excerpt, signal, valid)),
          },
        );
      },
      this.intents,
      () => this.mayRun(),
    );
    const work = processor
      .run(this.worker, this.controller.signal)
      .then(async (result) => {
        const outcome = String(result.outcome);
        if (outcome === 'idle') return;
        if (outcome === 'kept' || outcome === 'unsure' || outcome === 'delete_registered')
          this.lastSuccessAt = new Date().toISOString();
        this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
        this.logger.log(
          {
            stage: 'commercial-ai',
            mode: 'ENFORCE',
            heartbeatAt: new Date().toISOString(),
            lastSuccessAt: this.lastSuccessAt,
            ...result,
          },
          'Commercial AI result',
        );
      })
      .catch(() => {
        this.outcomes.dependency_unavailable = (this.outcomes.dependency_unavailable ?? 0) + 1;
        this.logDependencyFailure();
      })
      .finally(() => {
        this.active.delete(work);
      });
    this.active.add(work);
  }
}
