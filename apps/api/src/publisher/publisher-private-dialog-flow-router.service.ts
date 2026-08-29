import type { MaxUpdate } from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import { PublisherAutoReplyAuthoringService } from './publisher-auto-reply-authoring.service';
import { PublisherPostImportService } from './publisher-post-import.service';

@Injectable()
export class PublisherPrivateDialogFlowRouterService {
  constructor(
    private readonly autoReplyAuthoring: PublisherAutoReplyAuthoringService,
    private readonly postImport: PublisherPostImportService,
  ) {}

  async observeWebhook(
    update: MaxUpdate,
    webhookEventId: string | null,
    options: { duplicate?: boolean } = {},
  ): Promise<boolean> {
    if (await this.autoReplyAuthoring.observeWebhook(update, webhookEventId, options)) {
      return true;
    }
    return this.postImport.observeWebhook(update, webhookEventId, options);
  }
}
