import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { readPublisherInitDataKeysFile } from '../publisher/publisher-secret-files';

export type PublisherInitDataVerificationKeys = Readonly<{
  botId: string;
  keys: readonly Buffer[];
}>;

@Injectable()
export class PublisherInitDataKeyService {
  private readonly verificationKeys: PublisherInitDataVerificationKeys | null;

  constructor(configService: ConfigService) {
    const path = configService.get<string>('MAX_PUBLISHER_INIT_DATA_KEYS_FILE')?.trim();
    if (!path) {
      this.verificationKeys = null;
      return;
    }

    const descriptor = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    });
    const stored = readPublisherInitDataKeysFile(path);
    if (stored.botId !== descriptor.id) {
      throw new Error('MAX publisher init data key bot id does not match configuration');
    }
    this.verificationKeys = Object.freeze({
      botId: descriptor.id,
      keys: Object.freeze(stored.keys.map((key) => Buffer.from(key, 'base64'))),
    });
  }

  getVerificationKeys(): PublisherInitDataVerificationKeys | null {
    return this.verificationKeys;
  }
}
