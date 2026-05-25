import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Optional,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminSettingsService } from './admin-settings.service';
import { AdminService } from './admin.service';
import { ChannelDialogService } from './channel-dialog.service';
import { ManualModerationService } from './manual-moderation.service';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { VkParsingService } from './vk-parsing.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly managedGiveawayService: ManagedGiveawayService,
    @Optional() private readonly managedBroadcastService?: ManagedBroadcastService,
    @Optional() private readonly managedEntitiesService?: ManagedEntitiesService,
    @Optional() private readonly adminSettingsService?: AdminSettingsService,
    @Optional() private readonly manualModerationService?: ManualModerationService,
    @Optional() private readonly channelDialogService?: ChannelDialogService,
    @Optional() private readonly vkParsingFeatureService?: VkParsingService,
  ) {}

  @Get('me')
  me(
    @CurrentUser() user: AuthUser,
    @Query('chatId') chatId: string | undefined,
    @Query('entityType') entityType: string | undefined,
  ) {
    return this.entitiesService.getMe(user, {
      chatId,
      entityType: entityType === 'channel' ? 'channel' : entityType === 'chat' ? 'chat' : undefined,
      enrichFromMax: Boolean(chatId?.trim()),
    });
  }

  @Get('chats')
  getChats(
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
    @Query('includeRefreshState') includeRefreshState: string | undefined,
    @Query('bypassCache') bypassCache: string | undefined,
    @Query('fresh') fresh: string | undefined,
    @Query('resetCursor') resetCursor: string | undefined,
    @Query('sinceVersion') sinceVersion: string | undefined,
  ) {
    const options = {
      refresh: refresh === '1',
      fresh: fresh === '1',
      bypassRemoteCache: bypassCache === '1',
      resetRefreshCursor: resetCursor === '1',
      sinceVersion,
    };
    if (includeRefreshState === '1') {
      return this.entitiesService.listChatsWithRefreshState(user, options);
    }

    return this.entitiesService.listChats(user, options);
  }

  @Get('chats/:chatId/header')
  getChatHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.entitiesService.getChatHeader(chatId, user);
  }

  @Get('chats/:chatId/bots/plan')
  getChatBotExecutionPlan(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.entitiesService.getChatBotExecutionPlan(chatId, user, {
      refresh: refresh === '1',
    });
  }

  @Post('chats/:chatId/bots/primary')
  updateChatPrimaryBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChatPrimaryBot(chatId, user, body);
  }

  @Post('chats/:chatId/bots/partner-assist')
  updateChatPartnerAssist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChatPartnerAssist(chatId, user, body);
  }

  @Post('chats/:chatId/bots/promote-standby')
  promoteChatStandbyBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.promoteChatStandbyBot(chatId, user, body);
  }

  @Get('channels')
  getChannels(
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
    @Query('includeRefreshState') includeRefreshState: string | undefined,
    @Query('bypassCache') bypassCache: string | undefined,
    @Query('fresh') fresh: string | undefined,
    @Query('resetCursor') resetCursor: string | undefined,
    @Query('sinceVersion') sinceVersion: string | undefined,
  ) {
    const options = {
      refresh: refresh === '1',
      fresh: fresh === '1',
      bypassRemoteCache: bypassCache === '1',
      resetRefreshCursor: resetCursor === '1',
      sinceVersion,
    };
    if (includeRefreshState === '1') {
      return this.entitiesService.listChannelsWithRefreshState(user, options);
    }

    return this.entitiesService.listChannels(user, options);
  }

  @Get('channels/:chatId/header')
  getChannelHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.entitiesService.getChannelHeader(chatId, user);
  }

  @Put('managed-entities/:entityType/:entityId/favorites')
  updateManagedEntityFavorites(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateManagedEntityFavorites(entityType, entityId, user, body);
  }

  @Get('channels/:chatId/bots/plan')
  getChannelBotExecutionPlan(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.entitiesService.getChannelBotExecutionPlan(chatId, user, {
      refresh: refresh === '1',
    });
  }

  @Post('channels/:chatId/bots/primary')
  updateChannelPrimaryBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChannelPrimaryBot(chatId, user, body);
  }

  @Post('channels/:chatId/bots/partner-assist')
  updateChannelPartnerAssist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChannelPartnerAssist(chatId, user, body);
  }

  @Post('channels/:chatId/bots/promote-standby')
  promoteChannelStandbyBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.promoteChannelStandbyBot(chatId, user, body);
  }

  @Get('channels/:chatId/stats')
  getChannelStats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChannelStats(chatId, user, query);
  }

  @Get('channels/:chatId/activity-feed')
  getChannelActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChannelActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/settings')
  getSettings(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getSettings(chatId, user);
  }

  @Get('chats/:chatId/settings-screen')
  getChatSettingsScreen(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('prefetch') prefetch?: string,
  ) {
    return this.settingsService.getChatSettingsScreen(chatId, user, {
      liveAdminCheck: prefetch !== '1',
    });
  }

  @Post('chats/:chatId/required-subscription/channels/resolve')
  resolveRequiredSubscriptionChannel(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.resolveRequiredSubscriptionChannel(chatId, user, body);
  }

  @Put('chats/:chatId/settings')
  updateSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateSettings(chatId, user, body);
  }

  @Get('chats/:chatId/rules')
  getRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getRules(chatId, user);
  }

  @Get('chats/:chatId/activity-feed')
  getChatActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/moderation-feed')
  getChatModerationFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatModerationFeed(chatId, user, query);
  }

  @Get('chats/:chatId/moderation-dashboard')
  getChatModerationDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, {
      ...(query && typeof query === 'object' ? (query as Record<string, unknown>) : {}),
      includeActivityPreview: false,
      includeModerationPreview: true,
    });
  }

  @Get('chats/:chatId/activity-dashboard')
  getChatActivityDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, {
      ...(query && typeof query === 'object' ? (query as Record<string, unknown>) : {}),
      includeActivityPreview: true,
      includeModerationPreview: false,
    });
  }

  @Get('chats/:chatId/members')
  getChatParticipantsPage(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatParticipantsPage(chatId, user, query);
  }

  @Put('chats/:chatId/members/:userId/immunity')
  updateChatParticipantImmunity(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.updateChatParticipantImmunity(chatId, targetUserId, user, body);
  }

  @Put('chats/:chatId/rules')
  updateRules(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateRules(chatId, user, body);
  }

  @Post('chats/:chatId/rules/publish')
  publishRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.publishRules(chatId, user);
  }

  @Delete('chats/:chatId/rules/publish')
  resetPublishedRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.resetPublishedRules(chatId, user);
  }

  @Get('chats/:chatId/poll')
  getChatPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChatPoll(chatId, user);
  }

  @Put('chats/:chatId/poll')
  updateChatPoll(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateChatPoll(chatId, user, body);
  }

  @Post('chats/:chatId/poll/publish')
  publishChatPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.publishChatPoll(chatId, user);
  }

  @Post('chats/:chatId/poll/close')
  closeChatPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.closeChatPoll(chatId, user);
  }

  @Get('channels/:chatId/settings')
  getChannelSettings(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChannelSettings(chatId, user);
  }

  @Get('channels/:chatId/settings-screen')
  getChannelSettingsScreen(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('prefetch') prefetch?: string,
  ) {
    return this.settingsService.getChannelSettingsScreen(chatId, user, {
      liveAdminCheck: prefetch !== '1',
    });
  }

  @Put('channels/:chatId/settings')
  updateChannelSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateChannelSettings(chatId, user, body);
  }

  @Post('channels/:chatId/engagement-publish')
  publishChannelEngagementMessage(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.publishChannelEngagementMessage(chatId, user, body);
  }

  @Post('channels/:chatId/broadcast')
  sendChannelBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendChannelBroadcast(chatId, user, body);
  }

  @Post('channels/:chatId/broadcast/test')
  sendChannelBroadcastTest(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendChannelBroadcastTest(chatId, user, body);
  }

  @Get('channels/:chatId/broadcast-calendar')
  getChannelManagedBroadcastCalendar(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.broadcastService.getChannelManagedBroadcastCalendar(chatId, user, query);
  }

  @Get('channels/:chatId/broadcasts')
  getChannelManagedBroadcasts(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.broadcastService.listChannelManagedBroadcasts(chatId, user);
  }

  @Get('channels/:chatId/broadcasts/:broadcastId')
  getChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.getChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Put('channels/:chatId/broadcasts/:broadcastId')
  updateChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.updateChannelManagedBroadcast(chatId, broadcastId, user, body);
  }

  @Delete('channels/:chatId/broadcasts/:broadcastId')
  cancelChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.cancelChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Post('channels/:chatId/broadcasts/:broadcastId/retry')
  retryChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.retryChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Get('channels/:chatId/vk-parsing')
  getChannelVkParsing(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.listVkParsing(chatId, user);
  }

  @Get('channels/:chatId/vk-parsing/capability')
  getChannelVkParsingCapability(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.getCapability(chatId, user);
  }

  @Patch('channels/:chatId/vk-parsing/settings')
  updateChannelVkParsingSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateSettings(chatId, user, body);
  }

  @Post('channels/:chatId/vk-parsing/sources')
  addChannelVkParsingSource(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.addSource(chatId, user, body);
  }

  @Delete('channels/:chatId/vk-parsing/sources/:sourceId')
  removeChannelVkParsingSource(
    @Param('chatId') chatId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.removeSource(chatId, sourceId, user);
  }

  @Post('channels/:chatId/vk-parsing/refresh')
  refreshChannelVkParsing(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.refresh(chatId, user);
  }

  @Post('channels/:chatId/vk-parsing/posts/:postId/publish')
  publishChannelVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.publishPost(chatId, postId, user, body);
  }

  @Get('channels/:chatId/poll')
  getChannelPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChannelPoll(chatId, user);
  }

  @Put('channels/:chatId/poll')
  updateChannelPoll(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateChannelPoll(chatId, user, body);
  }

  @Post('channels/:chatId/poll/publish')
  publishChannelPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.publishChannelPoll(chatId, user);
  }

  @Post('channels/:chatId/poll/close')
  closeChannelPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.closeChannelPoll(chatId, user);
  }

  @Get('channels/:chatId/dialog/suggest/redirect')
  getChannelSuggestionRedirect(
    @Param('chatId') chatId: string,
    @CurrentUser() _user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.dialogService.getChannelSuggestionRedirect(chatId, token ?? null);
  }

  @Get('channels/:chatId/dialog/:dialogType')
  getChannelDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.dialogService.getChannelDialog(chatId, user, dialogType, token ?? null);
  }

  @Post('channels/:chatId/dialog/:dialogType/messages')
  createChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.createChannelDialogMessage(chatId, user, dialogType, body);
  }

  @Patch('channels/:chatId/dialog/:dialogType/messages/:messageId')
  updateChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.updateChannelDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Delete('channels/:chatId/dialog/:dialogType/messages/:messageId')
  deleteChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.deleteChannelDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Post('channels/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  toggleChannelDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.toggleChannelDialogReaction(
      chatId,
      user,
      dialogType,
      messageId,
      body,
    );
  }

  @Get('chats/:chatId/dialog/:dialogType')
  getChatDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.dialogService.getChatDialog(chatId, user, dialogType, token ?? null);
  }

  @Post('chats/:chatId/dialog/:dialogType/messages')
  createChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.createChatDialogMessage(chatId, user, dialogType, body);
  }

  @Patch('chats/:chatId/dialog/:dialogType/messages/:messageId')
  updateChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.updateChatDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Delete('chats/:chatId/dialog/:dialogType/messages/:messageId')
  deleteChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.deleteChatDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Post('chats/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  toggleChatDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.toggleChatDialogReaction(chatId, user, dialogType, messageId, body);
  }

  @Post('chats/:chatId/settings/apply-to-all')
  applySettingsToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.applySettingsToAllChats(chatId, user, body);
  }

  @Post('chats/:chatId/settings/apply-section-to-all')
  applySettingsSectionToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.applySettingsSectionToAllChats(chatId, user, body);
  }

  @Post('chats/:chatId/settings/apply-section-preview')
  previewApplySettingsSectionTarget(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.previewApplySettingsSectionTarget(chatId, user, body);
  }

  @Post('chats/:chatId/broadcast')
  sendBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendBroadcast(chatId, user, body);
  }

  @Post('chats/:chatId/broadcast/test')
  sendBroadcastTest(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendBroadcastTest(chatId, user, body);
  }

  @Get('chats/:chatId/broadcast-calendar')
  getManagedBroadcastCalendar(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.broadcastService.getManagedBroadcastCalendar(chatId, user, query);
  }

  @Get('chats/:chatId/broadcasts')
  getManagedBroadcasts(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.broadcastService.listManagedBroadcasts(chatId, user);
  }

  @Get('chats/:chatId/broadcasts/:broadcastId')
  getManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.getManagedBroadcast(chatId, broadcastId, user);
  }

  @Put('chats/:chatId/broadcasts/:broadcastId')
  updateManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.updateManagedBroadcast(chatId, broadcastId, user, body);
  }

  @Delete('chats/:chatId/broadcasts/:broadcastId')
  cancelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.cancelManagedBroadcast(chatId, broadcastId, user);
  }

  @Post('chats/:chatId/broadcasts/:broadcastId/retry')
  retryManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.retryManagedBroadcast(chatId, broadcastId, user);
  }

  @Get('chats/:chatId/vk-parsing')
  getChatVkParsing(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.listVkParsing(chatId, user);
  }

  @Get('chats/:chatId/vk-parsing/capability')
  getChatVkParsingCapability(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.getCapability(chatId, user);
  }

  @Patch('chats/:chatId/vk-parsing/settings')
  updateChatVkParsingSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateSettings(chatId, user, body);
  }

  @Post('chats/:chatId/vk-parsing/sources')
  addChatVkParsingSource(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.addSource(chatId, user, body);
  }

  @Delete('chats/:chatId/vk-parsing/sources/:sourceId')
  removeChatVkParsingSource(
    @Param('chatId') chatId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.removeSource(chatId, sourceId, user);
  }

  @Post('chats/:chatId/vk-parsing/refresh')
  refreshChatVkParsing(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.refresh(chatId, user);
  }

  @Post('chats/:chatId/vk-parsing/posts/:postId/publish')
  publishChatVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.publishPost(chatId, postId, user, body);
  }

  @Get('chats/:chatId/giveaways')
  getChatGiveaways(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.listManagedGiveaways(chatId, user, 'chat');
  }

  @Post('chats/:chatId/giveaways')
  createChatGiveaway(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.createManagedGiveaway(chatId, user, body, 'chat');
  }

  @Post('chats/:chatId/giveaways/required-channels/resolve')
  resolveChatGiveawayRequiredChannel(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.resolveManagedGiveawayRequiredChannel(
      chatId,
      user,
      body,
      'chat',
    );
  }

  @Get('chats/:chatId/giveaways/:giveawayId')
  getChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.getManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Put('chats/:chatId/giveaways/:giveawayId')
  updateChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.updateManagedGiveaway(
      chatId,
      giveawayId,
      user,
      body,
      'chat',
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/publish')
  publishChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.publishManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Post('chats/:chatId/giveaways/:giveawayId/close')
  closeChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.closeManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Post('chats/:chatId/giveaways/:giveawayId/reroll')
  rerollChatGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.rerollManagedGiveawayWinner(
      chatId,
      giveawayId,
      user,
      body,
      'chat',
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/deliver')
  deliverChatGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.markManagedGiveawayWinnerDelivered(
      chatId,
      giveawayId,
      user,
      body,
      'chat',
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/cancel')
  cancelChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.cancelManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Delete('chats/:chatId/giveaways/:giveawayId')
  deleteChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.deleteManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Get('chats/:chatId/moderation-events')
  getEvents(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getEvents(chatId, user, query);
  }

  @Get('channels/:chatId/giveaways')
  getChannelGiveaways(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.listManagedGiveaways(chatId, user, 'channel');
  }

  @Post('channels/:chatId/giveaways')
  createChannelGiveaway(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.createManagedGiveaway(chatId, user, body, 'channel');
  }

  @Post('channels/:chatId/giveaways/required-channels/resolve')
  resolveChannelGiveawayRequiredChannel(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.resolveManagedGiveawayRequiredChannel(
      chatId,
      user,
      body,
      'channel',
    );
  }

  @Get('channels/:chatId/giveaways/:giveawayId')
  getChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.getManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Put('channels/:chatId/giveaways/:giveawayId')
  updateChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.updateManagedGiveaway(
      chatId,
      giveawayId,
      user,
      body,
      'channel',
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/publish')
  publishChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.publishManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Post('channels/:chatId/giveaways/:giveawayId/close')
  closeChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.closeManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Post('channels/:chatId/giveaways/:giveawayId/reroll')
  rerollChannelGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.rerollManagedGiveawayWinner(
      chatId,
      giveawayId,
      user,
      body,
      'channel',
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/deliver')
  deliverChannelGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.markManagedGiveawayWinnerDelivered(
      chatId,
      giveawayId,
      user,
      body,
      'channel',
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/cancel')
  cancelChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.cancelManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Delete('channels/:chatId/giveaways/:giveawayId')
  deleteChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.deleteManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Get('giveaways/:giveawayId')
  getGiveaway(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.getPublicGiveaway(giveawayId, user);
  }

  @Get('giveaways/:giveawayId/me')
  getGiveawayMe(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.getGiveawayParticipantState(giveawayId, user);
  }

  @Post('giveaways/:giveawayId/enter')
  enterGiveaway(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.enterGiveaway(giveawayId, user);
  }

  @Post('giveaways/:giveawayId/claim')
  claimGiveaway(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.claimGiveaway(giveawayId, user);
  }

  @Get('chats/:chatId/logs-dashboard')
  getLogsDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, query);
  }

  @Post('chats/:chatId/members/:userId/moderation-action')
  applyManualModerationAction(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.applyManualModerationAction(chatId, targetUserId, user, body);
  }

  @Post('chats/:chatId/admin-allowlist')
  addAdmin(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.moderationService.addAdmin(chatId, user, body);
  }

  @Delete('chats/:chatId/admin-allowlist/:userId')
  removeAdmin(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeAdmin(chatId, user, targetUserId);
  }

  @Post('chats/:chatId/domain-allowlist')
  addDomain(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.moderationService.addDomain(chatId, user, body);
  }

  @Get('chats/:chatId/domain-allowlist')
  getDomainAllowlist(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.moderationService.getDomainAllowlist(chatId, user);
  }

  @Get('chats/:chatId/domain-allowlist/details')
  getDomainAllowlistDetails(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.moderationService.getDomainAllowlistDetails(chatId, user);
  }

  @Delete('chats/:chatId/domain-allowlist')
  removeDomainByQuery(
    @Param('chatId') chatId: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeDomain(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery),
    );
  }

  @Delete('chats/:chatId/domain-allowlist/:domain')
  removeDomain(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeDomain(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery, domain),
    );
  }

  @Put('chats/:chatId/domain-allowlist/removal-schedule')
  scheduleDomainRemovalByQuery(
    @Param('chatId') chatId: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.scheduleDomainRemoval(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery),
      body,
    );
  }

  @Put('chats/:chatId/domain-allowlist/:domain/removal-schedule')
  scheduleDomainRemoval(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.scheduleDomainRemoval(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery, domain),
      body,
    );
  }

  private get broadcastService(): ManagedBroadcastService | AdminService {
    return this.managedBroadcastService ?? this.adminService;
  }

  private get entitiesService(): ManagedEntitiesService | AdminService {
    return this.managedEntitiesService ?? this.adminService;
  }

  private get settingsService(): AdminSettingsService | AdminService {
    return this.adminSettingsService ?? this.adminService;
  }

  private get moderationService(): ManualModerationService | AdminService {
    return this.manualModerationService ?? this.adminService;
  }

  private get dialogService(): ChannelDialogService | AdminService {
    return this.channelDialogService ?? this.adminService;
  }

  private get vkParsingService(): VkParsingService {
    if (!this.vkParsingFeatureService) {
      throw new BadRequestException('ВК-парсинг недоступен.');
    }

    return this.vkParsingFeatureService;
  }

  private resolveAllowlistDomain(
    queryDomain: string | undefined,
    pathDomain?: string | undefined,
  ): string {
    const normalizedQueryDomain = queryDomain?.trim();
    if (normalizedQueryDomain) {
      return normalizedQueryDomain;
    }

    const normalizedPathDomain = pathDomain?.trim();
    if (normalizedPathDomain) {
      return normalizedPathDomain;
    }

    throw new BadRequestException('Allowlist domain is required');
  }
}
