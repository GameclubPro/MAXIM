import {
  addGlobalUserBlacklistRequestSchema,
  chatRulesSchema,
  channelStatsRangeSchema,
  channelStatsResponseSchema,
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  channelSettingsSchema,
  chatSettingsSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  domainAllowlistEntrySchema,
  publishChatRulesResultSchema,
  scheduleDomainRemovalRequestSchema,
  sendBroadcastRequestSchema,
  sendBroadcastResultSchema,
  moderationEventSchema,
  logsDashboardRangeSchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  chatSummarySchema,
  globalUserBlacklistEntrySchema,
  meSchema,
  type ChannelSettings,
  type ChatSettings,
  type ChatRules,
  type ChatSummary,
  type DomainAllowlistEntry,
  type GlobalUserBlacklistEntry,
  type Me,
  type ModerationEvent,
  type ChannelDialogType,
  type ChannelDialogResponse,
  type ChannelStatsRange,
  type ChannelStatsResponse,
  type CreateChannelDialogMessageResponse,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
  type PublishChatRulesResult,
  type SendBroadcastResult,
  updateChatRulesRequestSchema,
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

export type CreateChannelDialogMessagePayload = {
  token: string;
  text: string;
};

export type UpdateChatRulesPayload = Pick<
  ChatRules,
  'text' | 'imageBase64' | 'imageMimeType' | 'imageFileName'
>;

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

  async getChannels(): Promise<ChatSummary[]> {
    const response = await this.request('/channels');
    return response.map((item: unknown) => chatSummarySchema.parse(item));
  }

  async getChannelStats(
    chatId: string,
    range: ChannelStatsRange = '7d',
  ): Promise<ChannelStatsResponse> {
    const validatedRange = channelStatsRangeSchema.parse(range);
    const response = await this.request(
      `/channels/${chatId}/stats?range=${encodeURIComponent(validatedRange)}`,
    );
    return channelStatsResponseSchema.parse(response);
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

  async getRules(chatId: string): Promise<ChatRules> {
    const response = await this.request(`/chats/${chatId}/rules`);
    return chatRulesSchema.parse(response);
  }

  async updateRules(chatId: string, payload: UpdateChatRulesPayload): Promise<ChatRules> {
    const requestBody = updateChatRulesRequestSchema.parse(payload);
    const response = await this.request(`/chats/${chatId}/rules`, {
      method: 'PUT',
      body: JSON.stringify(requestBody),
    });
    return chatRulesSchema.parse(response);
  }

  async publishRules(chatId: string): Promise<PublishChatRulesResult> {
    const response = await this.request(`/chats/${chatId}/rules/publish`, {
      method: 'POST',
    });
    return publishChatRulesResultSchema.parse(response);
  }

  async getChannelSettings(chatId: string): Promise<ChannelSettings> {
    const response = await this.request(`/channels/${chatId}/settings`);
    return channelSettingsSchema.parse(response);
  }

  async updateChannelSettings(chatId: string, data: ChannelSettings): Promise<ChannelSettings> {
    const response = await this.request(`/channels/${chatId}/settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return channelSettingsSchema.parse(response);
  }

  async getChannelDialog(
    chatId: string,
    dialogType: ChannelDialogType,
    token: string,
  ): Promise<ChannelDialogResponse> {
    const parsedType = channelDialogTypeSchema.parse(dialogType);
    const response = await this.request(
      `/channels/${chatId}/dialog/${parsedType}?token=${encodeURIComponent(token)}`,
    );
    return channelDialogResponseSchema.parse(response);
  }

  async createChannelDialogMessage(
    chatId: string,
    dialogType: ChannelDialogType,
    payload: CreateChannelDialogMessagePayload,
  ): Promise<CreateChannelDialogMessageResponse> {
    const parsedType = channelDialogTypeSchema.parse(dialogType);
    const requestBody = createChannelDialogMessageRequestSchema.parse(payload);
    const response = await this.request(`/channels/${chatId}/dialog/${parsedType}/messages`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return createChannelDialogMessageResponseSchema.parse(response);
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

  async getLogsDashboard(
    chatId: string,
    range: LogsDashboardRange = '7d',
  ): Promise<LogsDashboardResponse> {
    const validatedRange = logsDashboardRangeSchema.parse(range);
    const response = await this.request(
      `/chats/${chatId}/logs-dashboard?range=${encodeURIComponent(validatedRange)}`,
    );
    return logsDashboardResponseSchema.parse(response);
  }

  async applyManualModerationAction(
    chatId: string,
    userId: string,
    payload: ManualModerationActionRequest,
  ): Promise<ManualModerationActionResult> {
    const requestBody = manualModerationActionRequestSchema.parse(payload);
    const response = await this.request(
      `/chats/${chatId}/members/${encodeURIComponent(userId)}/moderation-action`,
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
      },
    );
    return manualModerationActionResultSchema.parse(response);
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
    const headers = new Headers(init.headers);
    headers.set('Authorization', `InitData ${this.initData}`);
    const hasBody = init.body !== undefined && init.body !== null;
    const isFormDataBody = typeof FormData !== 'undefined' && init.body instanceof FormData;
    if (hasBody && !isFormDataBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`API request failed: ${response.status} ${payload}`);
    }

    return response.json();
  }
}
