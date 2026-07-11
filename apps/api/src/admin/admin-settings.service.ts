import {
  channelSettingsScreenResponseSchema,
  chatSettingsScreenResponseSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  type ApplySectionTargetPreviewResponse,
  type ApplySectionToAllResponse,
  type ApplySettingsTarget,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type PublishChannelEngagementResult,
  type PublishChatRulesResult,
  type ResolveRequiredSubscriptionChannelResponse,
} from '@maxim/contracts';
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import {
  publishChatRules,
  readChatRules,
  resetPublishedChatRules,
  saveChatRulesDraft,
} from './admin-chat-rules';
import { publishChannelEngagementMessage as publishChannelEngagementMessageValue } from './admin-channel-engagement';
import { readChannelSettings, saveChannelSettings } from './admin-channel-settings';
import { readChatSettings, saveChatSettings } from './admin-chat-settings';
import {
  applySettingsSectionToAllChats as applySettingsSectionToAllChatsValue,
  applySettingsToAllChats as applySettingsToAllChatsValue,
  previewApplySettingsSectionTarget as previewApplySettingsSectionTargetValue,
} from './admin-settings-apply';
import { AdminService } from './admin.service';
import { sanitizePublicManagedEntityHeader } from './admin-managed-entity-header';
import {
  type AdminActionSource,
  type AdminReadBypassOptions,
  type ApplySettingsToAllChatsResult,
} from './admin.service.support';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { ManualModerationService } from './manual-moderation.service';

const NIGHT_MODE_TRANSITION_SETTING_KEYS = new Set<keyof ChatSettings>([
  'nightModeEnabled',
  'nightModeStartTimeMinutes',
  'nightModeEndTimeMinutes',
  'nightModeTimezone',
]);

@Injectable()
export class AdminSettingsService {
  private readonly logger = new Logger(AdminSettingsService.name);

  constructor(
    private readonly legacyAdminService: AdminService,
    private readonly prisma: PrismaService,
    private readonly chatContextCache: ChatContextCacheService,
    private readonly maxClient: MaxClientService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    private readonly manualModerationService: ManualModerationService,
    private readonly managedBroadcastService: ManagedBroadcastService,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
  ) {}

  async getSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatSettings> {
    await this.legacyAdminService.assertManagedEntityReadAccess(
      chatId,
      user.userId,
      'chat',
      options,
    );
    const botAssignmentData =
      await this.legacyAdminService.resolveChatSettingsReadBotAssignmentData(chatId);
    return readChatSettings({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      logger: this.logger,
      chatId,
      botAssignmentData,
    });
  }

  async getChatSettingsScreen(
    chatId: string,
    user: AuthUser,
    options: { liveAdminCheck?: boolean } = {},
  ): Promise<ChatSettingsScreenResponse> {
    if (options.liveAdminCheck === false) {
      await this.legacyAdminService.assertManagedEntityReadAccess(chatId, user.userId, 'chat', {
        forceRemote: false,
        timeoutMs: undefined,
      });
    } else {
      await this.managedEntitiesService.assertManagedEntityDiagnosticsAccess(chatId, user, 'chat');
    }

    const [settings, rules, headerBundle, domains, managedBroadcasts] = await Promise.all([
      this.getSettings(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getRules(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.managedEntitiesService.getChatHeaderWithBotSpeechPreviewProfile(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
      this.manualModerationService.getDomainAllowlistDetails(chatId, user, {
        skipAdminCheck: true,
      }),
      this.managedBroadcastService.listManagedBroadcasts(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
    ]);
    const requiredSubscriptionChannels =
      await this.legacyAdminService.resolveRequiredSubscriptionChannelHeadersForSettings(
        settings.requiredSubscriptionChannelIds,
      );

    return chatSettingsScreenResponseSchema.parse({
      settings,
      rules,
      header: headerBundle.header,
      botSpeechPreviewProfile: headerBundle.botSpeechPreviewProfile,
      requiredSubscriptionChannels: requiredSubscriptionChannels.map((channel) =>
        sanitizePublicManagedEntityHeader(channel),
      ),
      domains,
      managedBroadcasts,
    });
  }

  async resolveRequiredSubscriptionChannel(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ResolveRequiredSubscriptionChannelResponse> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    const parsed = resolveRequiredSubscriptionChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channel = sanitizePublicManagedEntityHeader(
      await this.legacyAdminService.resolveRequiredSubscriptionChannelReferenceValue(
        parsed.data.value,
      ),
    );
    return resolveRequiredSubscriptionChannelResponseSchema.parse({ channel });
  }

  async updateSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatSettings> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    const shouldReconcileNightModeTransitions =
      this.shouldReconcileNightModeTransitionsAfterUpdate(body);
    const settings = await saveChatSettings({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      resolveBotAssignmentData: () =>
        this.legacyAdminService.resolveChatSettingsWriteBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.legacyAdminService.assertRequiredSubscriptionSettingsForChatSettings(settings),
      refreshExecutionReadiness: (settings) =>
        this.legacyAdminService.refreshChatSettingsExecutionReadiness(chatId, settings),
    });
    if (shouldReconcileNightModeTransitions) {
      await this.reconcileNightModeTransitions([chatId]);
    }
    return settings;
  }

  async getRules(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatRules> {
    await this.legacyAdminService.assertManagedEntityReadAccess(
      chatId,
      user.userId,
      'chat',
      options,
    );
    return readChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      resolveBotId: async () =>
        (await this.legacyAdminService.resolveChatSettingsReadBotAssignmentData(chatId)).botId,
    });
  }

  async updateRules(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return saveChatRulesDraft({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
    });
  }

  async publishRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<PublishChatRulesResult> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return publishChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      actorUserId: user.userId,
      source,
      resolveBotId: () => this.legacyAdminService.resolveChatRulesActionBotId(chatId),
      buildAutofilledText: () =>
        this.legacyAdminService.buildAutofilledChatRulesTextFromCurrentSettings(chatId, user),
      buildFormattedText: (sourceText, options) =>
        this.legacyAdminService.buildFormattedChatRulesPublicationText(chatId, sourceText, options),
      sendPrivateConfirmation: (publishedUrl) =>
        this.legacyAdminService.sendPublishedChatRulesPrivateConfirmation(user, publishedUrl),
    });
  }

  async resetPublishedRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return resetPublishedChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      source,
      resolveBotId: () => this.legacyAdminService.resolveChatRulesActionBotId(chatId),
    });
  }

  async getChannelSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChannelSettings> {
    await this.legacyAdminService.assertManagedEntityReadAccess(
      chatId,
      user.userId,
      'channel',
      options,
    );
    const botAssignmentData =
      await this.legacyAdminService.resolveChannelSettingsReadBotAssignmentData(chatId);
    return readChannelSettings({
      prisma: this.prisma,
      logger: this.logger,
      chatId,
      botAssignmentData,
    });
  }

  async getChannelSettingsScreen(
    chatId: string,
    user: AuthUser,
    options: { liveAdminCheck?: boolean } = {},
  ): Promise<ChannelSettingsScreenResponse> {
    if (options.liveAdminCheck === false) {
      await this.legacyAdminService.assertManagedEntityReadAccess(chatId, user.userId, 'channel', {
        forceRemote: false,
        timeoutMs: undefined,
      });
    } else {
      await this.managedEntitiesService.assertManagedEntityDiagnosticsAccess(
        chatId,
        user,
        'channel',
      );
    }

    const [settings, header, managedBroadcasts] = await Promise.all([
      this.getChannelSettings(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.managedEntitiesService.getChannelHeader(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
      this.managedBroadcastService.listChannelManagedBroadcasts(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
    ]);

    return channelSettingsScreenResponseSchema.parse({
      settings,
      header,
      managedBroadcasts,
    });
  }

  async updateChannelSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChannelSettings> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return saveChannelSettings({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      resolveBotAssignmentData: () =>
        this.legacyAdminService.resolveChannelSettingsWriteBotAssignmentData(chatId),
      refreshExecutionReadiness: () =>
        this.legacyAdminService.refreshChannelSettingsExecutionReadiness(chatId),
    });
  }

  async publishChannelEngagementMessage(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<PublishChannelEngagementResult> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return publishChannelEngagementMessageValue({
      prisma: this.prisma,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      body,
      resolveBotId: () => this.legacyAdminService.resolveChannelEngagementActionBotId(chatId),
      resolveEditBotId: () => this.legacyAdminService.resolveChannelEngagementEditBotId(chatId),
      buildDialogArtifacts: (params) =>
        this.legacyAdminService.buildChannelEngagementDialogArtifacts(params),
    });
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    targetOrSettingKeys: ApplySettingsTarget | readonly (keyof ChatSettings)[] = {
      mode: 'all',
      favoriteTypes: [],
      chatIds: [],
    },
    settingKeys?: readonly (keyof ChatSettings)[],
    botSpeechMediaKeys?: readonly string[],
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    const shouldReconcileNightModeTransitions = this.shouldReconcileNightModeTransitionsAfterApply(
      targetOrSettingKeys,
      settingKeys,
    );
    const result = await applySettingsToAllChatsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      sourceChatId,
      actorUserId: user.userId,
      body,
      source,
      targetOrSettingKeys,
      settingKeys,
      botSpeechMediaKeys,
      normalizeSettings: (settings) =>
        this.legacyAdminService.normalizeChatSettingsForApply(sourceChatId, settings),
      resolveTargetChats: (target) =>
        this.legacyAdminService.resolveSettingsApplyTargetChatsForSettings(
          sourceChatId,
          user,
          target,
        ),
      resolveBotAssignmentData: (chatId) =>
        this.legacyAdminService.resolveSettingsApplyBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.legacyAdminService.assertRequiredSubscriptionSettingsForChatSettings(settings),
      isRequiredSubscriptionCurrentlyActive: (settings) =>
        this.legacyAdminService.isRequiredSubscriptionCurrentlyActiveForSettings(settings),
      scheduleReadinessRefresh: (params) =>
        this.legacyAdminService.scheduleApplySettingsToAllReadinessRefreshForSettings(params),
    });
    if (shouldReconcileNightModeTransitions) {
      await this.reconcileNightModeTransitions(result.appliedChatIds);
    }
    return result;
  }

  async applySettingsSectionToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ApplySectionToAllResponse> {
    return applySettingsSectionToAllChatsValue({
      sourceChatId,
      body,
      source,
      getSourceSettings: () => this.getSettings(sourceChatId, user),
      applySettings: (settings, target, settingKeys, botSpeechMediaKeys) =>
        this.applySettingsToAllChats(
          sourceChatId,
          user,
          settings,
          source,
          target,
          settingKeys,
          botSpeechMediaKeys,
        ),
      syncDomainAllowlistToChats: (targetChatIds) =>
        this.legacyAdminService.syncDomainAllowlistToChatsForSettings(sourceChatId, targetChatIds),
    });
  }

  async previewApplySettingsSectionTarget(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ApplySectionTargetPreviewResponse> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    return previewApplySettingsSectionTargetValue({
      sourceChatId,
      body,
      resolveTargetChats: (target) =>
        this.legacyAdminService.resolveSettingsApplyTargetChatsForSettings(
          sourceChatId,
          user,
          target,
        ),
    });
  }

  private shouldReconcileNightModeTransitionsAfterApply(
    targetOrSettingKeys: ApplySettingsTarget | readonly (keyof ChatSettings)[],
    settingKeys?: readonly (keyof ChatSettings)[],
  ): boolean {
    const effectiveSettingKeys = Array.isArray(targetOrSettingKeys)
      ? targetOrSettingKeys
      : settingKeys;
    if (!Array.isArray(effectiveSettingKeys) || effectiveSettingKeys.length === 0) {
      return true;
    }

    return effectiveSettingKeys.some((key) => NIGHT_MODE_TRANSITION_SETTING_KEYS.has(key));
  }

  private shouldReconcileNightModeTransitionsAfterUpdate(body: unknown): boolean {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return false;
    }

    return Object.keys(body).some((key) =>
      NIGHT_MODE_TRANSITION_SETTING_KEYS.has(key as keyof ChatSettings),
    );
  }

  private async reconcileNightModeTransitions(chatIds: readonly string[]): Promise<void> {
    try {
      await this.nightModeTransitionScheduler?.reconcileChats(chatIds);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatIds,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to reconcile night mode transition jobs after settings update',
      );
    }
  }
}
