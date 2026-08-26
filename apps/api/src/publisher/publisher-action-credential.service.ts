import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { readPublisherActionTokenFile } from './publisher-secret-files';

@Injectable()
export class PublisherActionCredentialService {
  private readonly botId: string;
  private readonly actionToken: string;

  constructor(configService: ConfigService) {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher action credentials may only be loaded by api-publisher');
    }

    this.botId = configService.getOrThrow<string>('MAX_PUBLISHER_BOT_ID').trim();
    const tokenFile = configService.getOrThrow<string>('MAX_PUBLISHER_BOT_TOKEN_FILE').trim();
    this.actionToken = readPublisherActionTokenFile(tokenFile);
  }

  getBotId(): string {
    return this.botId;
  }

  getRequiredActionToken(botId: string): string {
    if (botId.trim() !== this.botId) {
      throw new Error(`api-publisher is not authorized to execute actions for bot ${botId.trim()}`);
    }
    return this.actionToken;
  }
}
