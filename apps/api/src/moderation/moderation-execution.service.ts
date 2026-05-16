import { Inject, Injectable } from '@nestjs/common';

export const MODERATION_EXECUTION_LEGACY = Symbol('MODERATION_EXECUTION_LEGACY');

export type ModerationExecutionLegacy = {
  processWebhookEvent(webhookEventId: string): Promise<void>;
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
}
