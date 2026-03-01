import {
  addGlobalUserBlacklistRequestSchema,
  chatSettingsSchema,
  domainAllowlistEntrySchema,
  scheduleDomainRemovalRequestSchema,
  sendBroadcastRequestSchema,
  sendBroadcastResultSchema,
  moderationEventSchema,
  chatSummarySchema,
  globalUserBlacklistEntrySchema,
  meSchema,
  type ChatSettings,
  type ChatSummary,
  type DomainAllowlistEntry,
  type GlobalUserBlacklistEntry,
  type Me,
  type ModerationEvent,
  type SendBroadcastResult,
} from '@maxim/contracts';

const API_BASE = '/api/v1';

export type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

export type SendBroadcastPayload = {
  text: string;
  applyToAllChats: boolean;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  sendAt: string | null;
  cycleEnabled: boolean;
  cycleEveryDays: number;
  cycleCount: number;
};

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

  async applySettingsToAllChats(
    chatId: string,
    data: ChatSettings,
  ): Promise<ApplySettingsToAllChatsResult> {
    const response = await this.request(`/chats/${chatId}/settings/apply-to-all`, {
      method: 'POST',
      body: JSON.stringify(data),
    });

    if (
      !response ||
      typeof response !== 'object' ||
      typeof (response as { sourceChatId?: unknown }).sourceChatId !== 'string' ||
      typeof (response as { updatedChats?: unknown }).updatedChats !== 'number' ||
      !Array.isArray((response as { appliedChatIds?: unknown }).appliedChatIds) ||
      (response as { appliedChatIds: unknown[] }).appliedChatIds.some(
        (item: unknown) => typeof item !== 'string',
      )
    ) {
      throw new Error('Invalid apply settings response');
    }

    return response as ApplySettingsToAllChatsResult;
  }

  async sendBroadcast(chatId: string, payload: SendBroadcastPayload): Promise<SendBroadcastResult> {
    const requestBody = sendBroadcastRequestSchema.parse(payload);
    const response = await this.request(`/chats/${chatId}/broadcast`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return sendBroadcastResultSchema.parse(response);
  }

  async getDomainAllowlist(chatId: string): Promise<string[]> {
    const response = await this.request(`/chats/${chatId}/domain-allowlist`);

    if (!Array.isArray(response) || response.some((item) => typeof item !== 'string')) {
      throw new Error('Invalid domain allowlist response');
    }

    return response;
  }

  async getDomainAllowlistDetails(chatId: string): Promise<DomainAllowlistEntry[]> {
    const response = await this.request(`/chats/${chatId}/domain-allowlist/details`);
    if (!Array.isArray(response)) {
      throw new Error('Invalid domain allowlist details response');
    }
    return response.map((item: unknown) => domainAllowlistEntrySchema.parse(item));
  }

  async addDomain(chatId: string, domain: string): Promise<void> {
    await this.request(`/chats/${chatId}/domain-allowlist`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    });
  }

  async removeDomain(chatId: string, domain: string): Promise<void> {
    await this.request(`/chats/${chatId}/domain-allowlist/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    });
  }

  async scheduleDomainRemoval(
    chatId: string,
    domain: string,
    removeAfterAt: string | null,
  ): Promise<void> {
    const payload = scheduleDomainRemovalRequestSchema.parse({ removeAfterAt });
    await this.request(
      `/chats/${chatId}/domain-allowlist/${encodeURIComponent(domain)}/removal-schedule`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
  }

  async getEvents(chatId: string): Promise<ModerationEvent[]> {
    const response = await this.request(`/chats/${chatId}/moderation-events?limit=50&page=1`);
    return response.map((item: unknown) => moderationEventSchema.parse(item));
  }

  async getGlobalUserBlacklist(chatId: string): Promise<GlobalUserBlacklistEntry[]> {
    const response = await this.request(`/chats/${chatId}/global-user-blacklist`);
    if (!Array.isArray(response)) {
      throw new Error('Invalid global user blacklist response');
    }
    return response.map((item: unknown) => globalUserBlacklistEntrySchema.parse(item));
  }

  async addGlobalUserBlacklistUser(chatId: string, userId: string): Promise<void> {
    const payload = addGlobalUserBlacklistRequestSchema.parse({ userId });
    await this.request(`/chats/${chatId}/global-user-blacklist`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async removeGlobalUserBlacklistUser(chatId: string, userId: string): Promise<void> {
    await this.request(`/chats/${chatId}/global-user-blacklist/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
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
