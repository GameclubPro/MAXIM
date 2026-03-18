import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
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
  managedEntityHeaderSchema,
  managedBroadcastDetailsSchema,
  managedBroadcastSummarySchema,
  logsDashboardRangeSchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  reviewSpammerCandidatesRequestSchema,
  reviewSpammerCandidatesResultSchema,
  managedGiveawayDetailsSchema,
  managedGiveawayHandoffRequestSchema,
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  managedGiveawaySummarySchema,
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  chatSummarySchema,
  meSchema,
  type ChannelSettings,
  type ChatSettings,
  type ChatRules,
  type ChatSummary,
  type DomainAllowlistEntry,
  type Me,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type ManagedGiveawayDetails,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
  type ManagedGiveawaySummary,
  type ModerationEvent,
  type ChannelDialogType,
  type ChannelDialogResponse,
  type ChannelStatsRange,
  type ChannelStatsResponse,
  type CreateChannelDialogMessageResponse,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManagedPoll,
  type ManagedEntityHeader,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
  type ReviewSpammerCandidatesRequest,
  type ReviewSpammerCandidatesResult,
  type PublishChannelEngagementRequest,
  type PublishChannelEngagementResult,
  type PublishChatRulesResult,
  spammerCandidateListResponseSchema,
  type SpammerCandidateListResponse,
  type UpdateManagedGiveawayRequest,
  type BroadcastTextFormat,
  type BroadcastHandoffResponse,
  type SendBroadcastResult,
  updateChatRulesRequestSchema,
  updateManagedGiveawayRequestSchema,
  managedPollSchema,
  markManagedGiveawayWinnerDeliveredRequestSchema,
  rerollManagedGiveawayWinnerRequestSchema,
  updateManagedPollRequestSchema,
} from '@maxim/contracts';

const API_BASE = '/api/v1';

export type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

export type SendBroadcastPayload = {
  text: string;
  textFormat: BroadcastTextFormat;
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
  cycleEveryHours: number;
  cycleCount: number;
};

export type UpdateManagedBroadcastPayload = SendBroadcastPayload;
export type UpdateManagedGiveawayPayload = UpdateManagedGiveawayRequest;
export type ManagedGiveawayHandoffPayload = {
  giveawayId: string | null;
};

export type BroadcastHandoffPayload = {
  applyToAllChats: boolean;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  sendAt: string | null;
  cycleEnabled: boolean;
  cycleEveryHours: number;
  cycleCount: number;
};

export type CreateChannelDialogMessagePayload = {
  token: string;
  text: string;
};

export type UpdateChatRulesPayload = Pick<
  ChatRules,
  'text' | 'imageBase64' | 'imageMimeType' | 'imageFileName' | 'autoTextEnabled'
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

  async getChatHeader(chatId: string): Promise<ManagedEntityHeader> {
    const response = await this.request(`/chats/${chatId}/header`);
    return managedEntityHeaderSchema.parse(response);
  }

  async getChannels(): Promise<ChatSummary[]> {
    const response = await this.request('/channels');
    return response.map((item: unknown) => chatSummarySchema.parse(item));
  }

  async getChannelHeader(chatId: string): Promise<ManagedEntityHeader> {
    const response = await this.request(`/channels/${chatId}/header`);
    return managedEntityHeaderSchema.parse(response);
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

  async resetPublishedRules(chatId: string): Promise<ChatRules> {
    const response = await this.request(`/chats/${chatId}/rules/publish`, {
      method: 'DELETE',
    });
    return chatRulesSchema.parse(response);
  }

  async getChatPoll(chatId: string): Promise<ManagedPoll> {
    const response = await this.request(`/chats/${chatId}/poll`);
    return managedPollSchema.parse(response);
  }

  async updateChatPoll(
    chatId: string,
    payload: { question: string; options: string[] },
  ): Promise<ManagedPoll> {
    const requestBody = updateManagedPollRequestSchema.parse(payload);
    const response = await this.request(`/chats/${chatId}/poll`, {
      method: 'PUT',
      body: JSON.stringify(requestBody),
    });
    return managedPollSchema.parse(response);
  }

  async publishChatPoll(chatId: string): Promise<ManagedPoll> {
    const response = await this.request(`/chats/${chatId}/poll/publish`, {
      method: 'POST',
    });
    return managedPollSchema.parse(response);
  }

  async closeChatPoll(chatId: string): Promise<ManagedPoll> {
    const response = await this.request(`/chats/${chatId}/poll/close`, {
      method: 'POST',
    });
    return managedPollSchema.parse(response);
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

  async publishChannelEngagement(
    chatId: string,
    payload: PublishChannelEngagementRequest,
  ): Promise<PublishChannelEngagementResult> {
    const requestBody = publishChannelEngagementRequestSchema.parse(payload);
    const response = await this.request(`/channels/${chatId}/engagement-publish`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return publishChannelEngagementResultSchema.parse(response);
  }

  async getChannelPoll(chatId: string): Promise<ManagedPoll> {
    const response = await this.request(`/channels/${chatId}/poll`);
    return managedPollSchema.parse(response);
  }

  async updateChannelPoll(
    chatId: string,
    payload: { question: string; options: string[] },
  ): Promise<ManagedPoll> {
    const requestBody = updateManagedPollRequestSchema.parse(payload);
    const response = await this.request(`/channels/${chatId}/poll`, {
      method: 'PUT',
      body: JSON.stringify(requestBody),
    });
    return managedPollSchema.parse(response);
  }

  async publishChannelPoll(chatId: string): Promise<ManagedPoll> {
    const response = await this.request(`/channels/${chatId}/poll/publish`, {
      method: 'POST',
    });
    return managedPollSchema.parse(response);
  }

  async closeChannelPoll(chatId: string): Promise<ManagedPoll> {
    const response = await this.request(`/channels/${chatId}/poll/close`, {
      method: 'POST',
    });
    return managedPollSchema.parse(response);
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

  async handoffBroadcast(
    chatId: string,
    payload: BroadcastHandoffPayload,
  ): Promise<BroadcastHandoffResponse> {
    const requestBody = broadcastHandoffRequestSchema.parse(payload);
    const response = await this.request(`/chats/${chatId}/broadcast/handoff`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return broadcastHandoffResponseSchema.parse(response);
  }

  async getManagedBroadcasts(chatId: string): Promise<ManagedBroadcastSummary[]> {
    const response = await this.request(`/chats/${chatId}/broadcasts`);
    if (!Array.isArray(response)) {
      throw new Error('Invalid managed broadcasts response');
    }
    return response.map((item: unknown) => managedBroadcastSummarySchema.parse(item));
  }

  async getManagedBroadcast(chatId: string, broadcastId: string): Promise<ManagedBroadcastDetails> {
    const response = await this.request(`/chats/${chatId}/broadcasts/${broadcastId}`);
    return managedBroadcastDetailsSchema.parse(response);
  }

  async updateManagedBroadcast(
    chatId: string,
    broadcastId: string,
    payload: UpdateManagedBroadcastPayload,
  ): Promise<ManagedBroadcastDetails> {
    const requestBody = sendBroadcastRequestSchema.parse(payload);
    const response = await this.request(`/chats/${chatId}/broadcasts/${broadcastId}`, {
      method: 'PUT',
      body: JSON.stringify(requestBody),
    });
    return managedBroadcastDetailsSchema.parse(response);
  }

  async cancelManagedBroadcast(
    chatId: string,
    broadcastId: string,
  ): Promise<ManagedBroadcastDetails> {
    const response = await this.request(`/chats/${chatId}/broadcasts/${broadcastId}`, {
      method: 'DELETE',
    });
    return managedBroadcastDetailsSchema.parse(response);
  }

  async retryManagedBroadcast(
    chatId: string,
    broadcastId: string,
  ): Promise<ManagedBroadcastDetails> {
    const response = await this.request(`/chats/${chatId}/broadcasts/${broadcastId}/retry`, {
      method: 'POST',
    });
    return managedBroadcastDetailsSchema.parse(response);
  }

  async sendChannelBroadcast(
    chatId: string,
    payload: SendBroadcastPayload,
  ): Promise<SendBroadcastResult> {
    const requestBody = sendBroadcastRequestSchema.parse(payload);
    const response = await this.request(`/channels/${chatId}/broadcast`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return sendBroadcastResultSchema.parse(response);
  }

  async handoffChannelBroadcast(
    chatId: string,
    payload: BroadcastHandoffPayload,
  ): Promise<BroadcastHandoffResponse> {
    const requestBody = broadcastHandoffRequestSchema.parse(payload);
    const response = await this.request(`/channels/${chatId}/broadcast/handoff`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return broadcastHandoffResponseSchema.parse(response);
  }

  async getManagedGiveaways(
    entityType: 'chat' | 'channel',
    entityId: string,
  ): Promise<ManagedGiveawaySummary[]> {
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways`,
    );
    if (!Array.isArray(response)) {
      throw new Error('Invalid managed giveaways response');
    }
    return response.map((item: unknown) => managedGiveawaySummarySchema.parse(item));
  }

  async createManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    payload: UpdateManagedGiveawayPayload,
  ): Promise<ManagedGiveawayDetails> {
    const requestBody = updateManagedGiveawayRequestSchema.parse(payload);
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways`,
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
      },
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async getManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
  ): Promise<ManagedGiveawayDetails> {
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}`,
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async updateManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
    payload: UpdateManagedGiveawayPayload,
  ): Promise<ManagedGiveawayDetails> {
    const requestBody = updateManagedGiveawayRequestSchema.parse(payload);
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}`,
      {
        method: 'PUT',
        body: JSON.stringify(requestBody),
      },
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async publishManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
  ): Promise<ManagedGiveawayDetails> {
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}/publish`,
      {
        method: 'POST',
      },
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async closeManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
  ): Promise<ManagedGiveawayDetails> {
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}/close`,
      {
        method: 'POST',
      },
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async rerollManagedGiveawayWinner(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
    winnerId: string,
  ): Promise<ManagedGiveawayDetails> {
    const requestBody = rerollManagedGiveawayWinnerRequestSchema.parse({ winnerId });
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}/reroll`,
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
      },
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async markManagedGiveawayWinnerDelivered(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
    winnerId: string,
  ): Promise<ManagedGiveawayDetails> {
    const requestBody = markManagedGiveawayWinnerDeliveredRequestSchema.parse({ winnerId });
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}/deliver`,
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
      },
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async cancelManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
  ): Promise<ManagedGiveawayDetails> {
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}/cancel`,
      {
        method: 'POST',
      },
    );
    return managedGiveawayDetailsSchema.parse(response);
  }

  async deleteManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    giveawayId: string,
  ): Promise<void> {
    await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaways/${giveawayId}`,
      {
        method: 'DELETE',
      },
    );
  }

  async handoffManagedGiveaway(
    entityType: 'chat' | 'channel',
    entityId: string,
    payload: ManagedGiveawayHandoffPayload,
  ): Promise<BroadcastHandoffResponse> {
    const requestBody = managedGiveawayHandoffRequestSchema.parse(payload);
    const response = await this.request(
      `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}/giveaway/handoff`,
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
      },
    );
    return broadcastHandoffResponseSchema.parse(response);
  }

  async getPublicGiveaway(giveawayId: string): Promise<ManagedGiveawayPublic> {
    const response = await this.request(`/giveaways/${giveawayId}`);
    return managedGiveawayPublicSchema.parse(response);
  }

  async getGiveawayParticipantState(giveawayId: string): Promise<ManagedGiveawayParticipantState> {
    const response = await this.request(`/giveaways/${giveawayId}/me`);
    return managedGiveawayParticipantStateSchema.parse(response);
  }

  async enterGiveaway(giveawayId: string): Promise<ManagedGiveawayParticipantState> {
    const response = await this.request(`/giveaways/${giveawayId}/enter`, {
      method: 'POST',
    });
    return managedGiveawayParticipantStateSchema.parse(response);
  }

  async claimGiveaway(giveawayId: string): Promise<void> {
    await this.request(`/giveaways/${giveawayId}/claim`, {
      method: 'POST',
    });
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

  async getSpammerCandidates(chatId: string): Promise<SpammerCandidateListResponse> {
    const response = await this.request(`/chats/${chatId}/spammer-candidates`);
    return spammerCandidateListResponseSchema.parse(response);
  }

  async reviewSpammerCandidates(
    chatId: string,
    payload: ReviewSpammerCandidatesRequest,
  ): Promise<ReviewSpammerCandidatesResult> {
    const requestBody = reviewSpammerCandidatesRequestSchema.parse(payload);
    const response = await this.request(`/chats/${chatId}/spammer-candidates/review`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return reviewSpammerCandidatesResultSchema.parse(response);
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

    if (response.status === 204 || response.status === 205) {
      return null;
    }

    const payload = await response.text();
    if (!payload.trim()) {
      return null;
    }

    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
}
