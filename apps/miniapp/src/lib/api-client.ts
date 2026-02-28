import {
  chatSettingsSchema,
  moderationEventSchema,
  chatSummarySchema,
  meSchema,
  type ChatSettings,
  type ChatSummary,
  type Me,
  type ModerationEvent,
} from '@maxim/contracts';

const API_BASE = '/api/v1';

export class ApiClient {
  constructor(private readonly initData: string) {}

  async getMe(): Promise<Me> {
    const response = await this.request('/me');
    return meSchema.parse(response);
  }

  async getChats(): Promise<ChatSummary[]> {
    const response = await this.request('/chats');
    return response.map((item: unknown) => chatSummarySchema.parse(item));
  }

  async getSettings(chatId: string): Promise<ChatSettings> {
    const response = await this.request(`/chats/${chatId}/settings`);
    return chatSettingsSchema.parse(response);
  }

  async updateSettings(chatId: string, data: ChatSettings): Promise<ChatSettings> {
    const response = await this.request(`/chats/${chatId}/settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return chatSettingsSchema.parse(response);
  }

  async getEvents(chatId: string): Promise<ModerationEvent[]> {
    const response = await this.request(`/chats/${chatId}/moderation-events?limit=50&page=1`);
    return response.map((item: unknown) => moderationEventSchema.parse(item));
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `InitData ${this.initData}`,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`API request failed: ${response.status} ${payload}`);
    }

    return response.json();
  }
}
