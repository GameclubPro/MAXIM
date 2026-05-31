import { Inject, Injectable } from '@nestjs/common';
import type { NightModeTransitionJob } from './night-mode-transition.queue';

export const MODERATION_EXECUTION_LEGACY = Symbol('MODERATION_EXECUTION_LEGACY');

export type ModerationExecutionLegacy = {
  processWebhookEvent(webhookEventId: string): Promise<void>;
  processNightModeTransitionJob(job: NightModeTransitionJob): Promise<void>;
};

@Injectable()
export class ModerationExecutionService {
  constructor(
    @Inject(MODERATION_EXECUTION_LEGACY)
    private readonly legacyModerationService: ModerationExecutionLegacy,
  ) {}

  async processWebhookEvent(webhookEventId: string): Promise<void> {
    await this.legacyModerationService.processWebhookEvent(webhookEventId);
  }

  async processNightModeTransitionJob(job: NightModeTransitionJob): Promise<void> {
    await this.legacyModerationService.processNightModeTransitionJob(job);
  }
}
