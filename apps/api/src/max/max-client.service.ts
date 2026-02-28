import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class MaxClientService {
  private readonly logger = new Logger(MaxClientService.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
  ) {
    this.baseUrl = configService.getOrThrow<string>('MAX_API_BASE_URL');
    this.token = configService.getOrThrow<string>('MAX_BOT_TOKEN');
  }

  async deleteMessage(chatId: string, messageId: string) {
    await this.request('delete', `/messages/${messageId}`, {
      params: {
        chat_id: chatId,
      },
    });
  }

  async kickMember(chatId: string, userId: string) {
    await this.request('delete', `/chats/${chatId}/members/${userId}`);
  }

  async banMember(chatId: string, userId: string) {
    await this.request('delete', `/chats/${chatId}/members/${userId}`, {
      params: {
        block: true,
      },
    });
  }

  async notifyModerators(chatId: string, text: string) {
    this.logger.warn({ chatId, text }, 'Moderator alert');
  }

  private async request(method: 'delete' | 'post' | 'get', path: string, config: Record<string, unknown> = {}) {
    const url = `${this.baseUrl}${path}`;
    await firstValueFrom(
      this.httpService.request({
        method,
        url,
        ...config,
        headers: {
          Authorization: this.token,
          ...(config.headers as Record<string, string> | undefined),
        },
      }),
    );
  }
}
