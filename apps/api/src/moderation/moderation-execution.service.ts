import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
  NightModeTransitionJob,
  NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import type { PhotoDuplicateJob } from './photo-duplicate/photo-duplicate.queue';
import { PhotoDuplicateModerationService } from './photo-duplicate/photo-duplicate-moderation.service';
import type { PhotoDuplicateOrderingLease } from './photo-duplicate/photo-duplicate-ordering.store';
import { MessageDuplicateMediaService } from './message-duplicate/message-duplicate-media.service';
import type { MessageDuplicateJob } from './message-duplicate/message-duplicate.queue';

export const MODERATION_EXECUTION_LEGACY = Symbol('MODERATION_EXECUTION_LEGACY');

export type ModerationExecutionLegacy = {
  processWebhookEvent(webhookEventId: string): Promise<void>;
  processNightModeTransitionJob(
    job: NightModeTransitionJob,
  ): Promise<NightModeTransitionProcessResult>;
};

@Injectable()
export class ModerationExecutionService {
  constructor(
    @Inject(MODERATION_EXECUTION_LEGACY)
    private readonly legacyModerationService: ModerationExecutionLegacy,
    @Optional()
    private readonly photoDuplicateModerationService?: PhotoDuplicateModerationService,
    @Optional() private readonly messageDuplicateMediaService?: MessageDuplicateMediaService,
  ) {}

  async processWebhookEvent(webhookEventId: string): Promise<void> {
    await this.legacyModerationService.processWebhookEvent(webhookEventId);
  }

  async processMessageDuplicateJob(
    job: MessageDuplicateJob,
    lease: PhotoDuplicateOrderingLease,
  ): Promise<void> {
    if (!this.messageDuplicateMediaService)
      throw new Error('Message duplicate media execution unavailable');
    await this.messageDuplicateMediaService.process(job, lease);
  }

  async processNightModeTransitionJob(
    job: NightModeTransitionJob,
  ): Promise<NightModeTransitionProcessResult> {
    return this.legacyModerationService.processNightModeTransitionJob(job);
  }

  async processPhotoDuplicateJob(
    job: PhotoDuplicateJob,
    lease: PhotoDuplicateOrderingLease,
  ): Promise<void> {
    if (!this.photoDuplicateModerationService) {
      throw new Error('Photo duplicate moderation execution is unavailable in this runtime');
    }
    await this.photoDuplicateModerationService.processPhotoDuplicateJob(job, lease);
  }
}
