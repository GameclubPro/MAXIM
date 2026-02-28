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

  async getChatTitle(chatId: string): Promise<string | null> {
    const data = await this.request<Record<string, unknown>>('get', `/chats/${chatId}`);
    const value = data.title ?? data.name;

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  async notifyModerators(chatId: string, text: string) {
    this.logger.warn({ chatId, text }, 'Moderator alert');
  }

  private async request<T = unknown>(
    method: 'delete' | 'post' | 'get',
    path: string,
    config: Record<string, unknown> = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        ...config,
        headers: {
          Authorization: this.token,
          ...(config.headers as Record<string, string> | undefined),
        },
      }),
    );

    return response.data;
  }
}
