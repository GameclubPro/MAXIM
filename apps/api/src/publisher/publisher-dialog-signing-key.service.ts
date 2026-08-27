import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { readPublisherDialogSigningKeysFile } from './publisher-secret-files';

@Injectable()
export class PublisherDialogSigningKeyService {
  private readonly keys: readonly string[];

  constructor(configService: ConfigService) {
    const path = configService.get<string>('MAX_PUBLISHER_DIALOG_SIGNING_KEY_FILE')?.trim();
    if (!path) {
      this.keys = Object.freeze([]);
      return;
    }

    const publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    const stored = readPublisherDialogSigningKeysFile(path);
    if (stored.botId !== publisherBotId) {
      throw new Error('MAX publisher dialog signing key bot id does not match configuration');
    }
    this.keys = Object.freeze([...stored.keys]);
  }

  getSigningKeys(): readonly string[] {
    return this.keys;
  }
}
