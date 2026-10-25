import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import { CommercialLlmCascadeClient } from './commercial-llm-cascade.client';
import { CommercialLlmClient } from './commercial-llm.client';
import { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import { CommercialLlmShadowLease, createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { commercialLlmHostHasHeadroom } from './commercial-llm-shadow.processor';
import { COMMERCIAL_LLM_ENFORCEMENT_KEYS } from './commercial-llm-enforcement.mailbox';
import { CommercialLlmBudgetedSecondary } from './commercial-llm-budgeted-secondary';

@Injectable()
export class CommercialLlmEnforcementRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommercialLlmEnforcementRunnerService.name);
  private readonly worker = randomUUID();
  private readonly controller = new AbortController();
  private redis: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private active: Promise<void> | null = null;
  private lastSuccessAt: string | null = null;
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
    this.timer = setInterval(() => {
      if (this.polling || this.controller.signal.aborted) return;
      this.polling = this.poll()
        .catch(() => undefined)
        .finally(() => {
          this.polling = null;
        });
    }, 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.timer) return;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.polling;
    await this.active;
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

  private async poll(): Promise<void> {
    const mailbox = await this.admission.mailbox();
    if (!(await mailbox.heartbeat(this.worker)) || this.active || this.controller.signal.aborted)
      return;
    if (!this.redis || this.redis.status !== 'ready') {
      this.redis?.disconnect();
      this.redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
      await this.redis.connect();
    }
    const redis = this.redis;
    const processor = new CommercialLlmEnforcementProcessor(
      mailbox,
      new CommercialLlmCascadeClient(
        new CommercialLlmWorkstationMailbox(redis),
        new CommercialLlmBudgetedSecondary(
          new CommercialLlmShadowLease(redis),
          new CommercialLlmClient({
            endpoint: this.config.getOrThrow<string>('COMMERCIAL_LLM_ENDPOINT'),
          }),
        ),
        () => this.mayRun(),
      ),
      this.intents,
      () => this.mayRun(),
    );
    this.active = (async () => {
      const result = await processor.run(this.worker, this.controller.signal);
      if (result.outcome === 'kept' || result.outcome === 'delete_registered')
        this.lastSuccessAt = new Date().toISOString();
      const status = {
        stage: 'commercial-ai',
        mode: 'ENFORCE',
        heartbeatAt: new Date().toISOString(),
        lastSuccessAt: this.lastSuccessAt,
        ...result,
      };
      await redis.set(COMMERCIAL_LLM_ENFORCEMENT_KEYS.status, JSON.stringify(status), 'EX', 30);
      if (result.outcome !== 'idle') this.logger.log(status, 'Commercial AI result');
      if (!this.controller.signal.aborted && (await this.mayRun()))
        await mailbox.advertise(this.worker);
      else await mailbox.withdraw(this.worker);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.active = null;
      });
  }
}
