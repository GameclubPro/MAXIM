import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export type MaxBotChat = {
  chatId: string;
  title: string | null;
  lastEventTime: number | null;
};

export type MaxMessageButton = {
  text: string;
  url: string;
};

export type MaxSendMessageOptions = {
  button?: MaxMessageButton;
};

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
    await this.request('delete', '/messages', {
      params: {
        message_id: messageId,
        chat_id: chatId,
      },
    });
  }

  async sendMessage(chatId: string, text: string, options?: MaxSendMessageOptions) {
    const attachment = this.buildInlineKeyboardAttachment(options?.button);
    await this.request('post', '/messages', {
      params: {
        chat_id: chatId,
      },
      data: {
        text,
        ...(attachment ? { attachments: [attachment] } : {}),
      },
    });
  }

  async kickMember(chatId: string, userId: string) {
    await this.request('delete', `/chats/${chatId}/members`, {
      params: {
        user_id: userId,
      },
    });
  }

  async banMember(chatId: string, userId: string) {
    await this.request('delete', `/chats/${chatId}/members`, {
      params: {
        user_id: userId,
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

  async getChatAdminIds(chatId: string): Promise<string[]> {
    const data = await this.request<Record<string, unknown>>(
      'get',
      `/chats/${chatId}/members/admins`,
    );
    const members = Array.isArray(data.members) ? data.members : [];

    return members
      .map((member) => {
        if (!member || typeof member !== 'object') {
          return null;
        }

        const row = member as Record<string, unknown>;
        const value = row.user_id ?? row.userId ?? row.id;
        if (typeof value === 'number' || typeof value === 'string') {
          return String(value);
        }
        return null;
      })
      .filter((value): value is string => value !== null);
  }

  async listBotChats(): Promise<MaxBotChat[]> {
    const results: MaxBotChat[] = [];
    const seenMarkers = new Set<string>();
    let marker: string | number | null = null;

    for (let i = 0; i < 20; i += 1) {
      const pageData: Record<string, unknown> = await this.request('get', '/chats', {
        params: {
          count: 100,
          ...(marker !== null ? { marker } : {}),
        },
      });

      const pageChats = Array.isArray(pageData.chats) ? pageData.chats : [];
      for (const item of pageChats) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as Record<string, unknown>;
        const chatId = row.chat_id ?? row.chatId ?? row.id;
        if (typeof chatId !== 'string' && typeof chatId !== 'number') {
          continue;
        }

        const title = row.title ?? row.name;
        const lastEventTime = row.last_event_time ?? row.lastEventTime;
        results.push({
          chatId: String(chatId),
          title: typeof title === 'string' ? title : null,
          lastEventTime:
            typeof lastEventTime === 'number'
              ? lastEventTime
              : typeof lastEventTime === 'string' && lastEventTime.trim() !== ''
                ? Number(lastEventTime)
                : null,
        });
      }

      const nextMarker: unknown = pageData.marker;
      if (
        nextMarker === null ||
        nextMarker === undefined ||
        (typeof nextMarker !== 'string' && typeof nextMarker !== 'number')
      ) {
        break;
      }

      const markerKey = String(nextMarker);
      if (seenMarkers.has(markerKey)) {
        break;
      }
      seenMarkers.add(markerKey);
      marker = nextMarker;
    }

    return results;
  }

  async notifyModerators(chatId: string, text: string) {
    this.logger.warn({ chatId, text }, 'Moderator alert');
  }

  private buildInlineKeyboardAttachment(button?: MaxMessageButton): Record<string, unknown> | null {
    if (!button) {
      return null;
    }

    return {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: button.text,
              url: button.url,
            },
          ],
        ],
      },
    };
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
