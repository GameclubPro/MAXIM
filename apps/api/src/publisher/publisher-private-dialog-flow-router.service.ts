import type { MaxUpdate } from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import { PublisherAutoReplyAuthoringService } from './publisher-auto-reply-authoring.service';
import { PublisherPostImportService } from './publisher-post-import.service';
import { PublisherSuggestionAdminCallbackObserverService } from './publisher-suggestion-admin-callback-observer.service';
import { PublisherStartQueueService } from './publisher-start.queue';

@Injectable()
export class PublisherPrivateDialogFlowRouterService {
  constructor(
    private readonly suggestionAdminCallbacks: PublisherSuggestionAdminCallbackObserverService,
    private readonly autoReplyAuthoring: PublisherAutoReplyAuthoringService,
    private readonly postImport: PublisherPostImportService,
    private readonly start: PublisherStartQueueService,
  ) {}

  async observeWebhook(
    update: MaxUpdate,
    webhookEventId: string | null,
    options: { duplicate?: boolean } = {},
  ): Promise<boolean> {
    if (await this.suggestionAdminCallbacks.observeWebhook(update, webhookEventId, options)) {
      return true;
    }
    if (await this.autoReplyAuthoring.observeWebhook(update, webhookEventId, options)) {
      return true;
    }
    if (await this.postImport.observeWebhook(update, webhookEventId, options)) {
      return true;
    }
    return this.start.observeWebhook(update);
  }
}
