import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import {
  buildPublisherBotDescriptor,
  type PublisherBotDescriptor,
} from './publisher-bot-descriptor';
import {
  readPublisherWebhookCredentialFile,
  type PublisherWebhookCredential,
} from './publisher-secret-files';

@Injectable()
export class PublisherWebhookCredentialService {
  private readonly credential: PublisherWebhookCredential | null;
  private readonly descriptor: PublisherBotDescriptor;

  constructor(configService: ConfigService) {
    this.descriptor = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    });
    const path = configService.get<string>('MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE')?.trim();
    this.credential = path ? readPublisherWebhookCredentialFile(path) : null;
    if (this.credential && this.credential.botId !== this.descriptor.id) {
      throw new Error('MAX publisher webhook credential bot id does not match configuration');
    }
  }

  isConfigured(): boolean {
    return this.credential !== null;
  }

  getConfiguredCredential(): Readonly<PublisherWebhookCredential> | null {
    return this.credential;
  }

  resolveWebhookBot(params: {
    botId: string;
    secretPath: string;
    providedHeaderSecret: string;
  }): PublisherBotDescriptor | null {
    const credential = this.credential;
    if (
      !credential ||
      params.botId.trim() !== credential.botId ||
      params.secretPath.trim() !== credential.secretPath
    ) {
      return null;
    }

    return credential.headerSecrets.some((expected) =>
      this.constantTimeEquals(params.providedHeaderSecret, expected),
    )
      ? this.descriptor
      : null;
  }
  private constantTimeEquals(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    return (
      providedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(providedBuffer, expectedBuffer)
    );
  }
}
