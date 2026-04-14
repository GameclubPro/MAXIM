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
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { ManagedGiveawayService } from './managed-giveaway.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly managedGiveawayService: ManagedGiveawayService,
  ) {}

  @Get('me')
  me(
    @CurrentUser() user: AuthUser,
    @Query('chatId') chatId: string | undefined,
    @Query('entityType') entityType: string | undefined,
  ) {
    return this.adminService.getMe(user, {
      chatId,
      entityType: entityType === 'channel' ? 'channel' : entityType === 'chat' ? 'chat' : undefined,
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
      return this.adminService.listChatsWithRefreshState(user, options);
    }

    return this.adminService.listChats(user, options);
  }

  @Get('chats/:chatId/header')
  getChatHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChatHeader(chatId, user);
  }

  @Get('chats/:chatId/bots/plan')
  getChatBotExecutionPlan(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.adminService.getChatBotExecutionPlan(chatId, user, {
      refresh: refresh === '1',
    });
  }

  @Post('chats/:chatId/bots/primary')
  updateChatPrimaryBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChatPrimaryBot(chatId, user, body);
  }

  @Post('chats/:chatId/bots/partner-assist')
  updateChatPartnerAssist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChatPartnerAssist(chatId, user, body);
  }

  @Post('chats/:chatId/bots/promote-standby')
  promoteChatStandbyBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.promoteChatStandbyBot(chatId, user, body);
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
      return this.adminService.listChannelsWithRefreshState(user, options);
    }

    return this.adminService.listChannels(user, options);
  }

  @Get('channels/:chatId/header')
  getChannelHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChannelHeader(chatId, user);
  }

  @Get('channels/:chatId/bots/plan')
  getChannelBotExecutionPlan(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.adminService.getChannelBotExecutionPlan(chatId, user, {
      refresh: refresh === '1',
    });
  }

  @Post('channels/:chatId/bots/primary')
  updateChannelPrimaryBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChannelPrimaryBot(chatId, user, body);
  }

  @Post('channels/:chatId/bots/partner-assist')
  updateChannelPartnerAssist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChannelPartnerAssist(chatId, user, body);
  }

  @Post('channels/:chatId/bots/promote-standby')
  promoteChannelStandbyBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.promoteChannelStandbyBot(chatId, user, body);
  }

  @Get('channels/:chatId/stats')
  getChannelStats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.adminService.getChannelStats(chatId, user, query);
  }

  @Get('channels/:chatId/activity-feed')
  getChannelActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.adminService.getChannelActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/settings')
  getSettings(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getSettings(chatId, user);
  }

  @Get('chats/:chatId/settings-screen')
  getChatSettingsScreen(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChatSettingsScreen(chatId, user);
  }

  @Post('chats/:chatId/required-subscription/channels/resolve')
  resolveRequiredSubscriptionChannel(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.resolveRequiredSubscriptionChannel(chatId, user, body);
  }

  @Put('chats/:chatId/settings')
  updateSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateSettings(chatId, user, body);
  }

  @Get('chats/:chatId/rules')
  getRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getRules(chatId, user);
  }

  @Get('chats/:chatId/activity-feed')
  getChatActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.adminService.getChatActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/moderation-feed')
  getChatModerationFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.adminService.getChatModerationFeed(chatId, user, query);
  }

  @Get('chats/:chatId/members')
  getChatParticipantsPage(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.adminService.getChatParticipantsPage(chatId, user, query);
  }

  @Put('chats/:chatId/rules')
  updateRules(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateRules(chatId, user, body);
  }

  @Post('chats/:chatId/rules/publish')
  publishRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.publishRules(chatId, user);
  }

  @Delete('chats/:chatId/rules/publish')
  resetPublishedRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.resetPublishedRules(chatId, user);
  }

  @Get('chats/:chatId/poll')
  getChatPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChatPoll(chatId, user);
  }

  @Put('chats/:chatId/poll')
  updateChatPoll(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChatPoll(chatId, user, body);
  }

  @Post('chats/:chatId/poll/publish')
  publishChatPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.publishChatPoll(chatId, user);
  }

  @Post('chats/:chatId/poll/close')
  closeChatPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.closeChatPoll(chatId, user);
  }

  @Get('channels/:chatId/settings')
  getChannelSettings(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChannelSettings(chatId, user);
  }

  @Get('channels/:chatId/settings-screen')
  getChannelSettingsScreen(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChannelSettingsScreen(chatId, user);
  }

  @Put('channels/:chatId/settings')
  updateChannelSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChannelSettings(chatId, user, body);
  }

  @Post('channels/:chatId/engagement-publish')
  publishChannelEngagementMessage(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.publishChannelEngagementMessage(chatId, user, body);
  }

  @Post('channels/:chatId/broadcast')
  sendChannelBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.sendChannelBroadcast(chatId, user, body);
  }

  @Get('channels/:chatId/broadcasts')
  getChannelManagedBroadcasts(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.listChannelManagedBroadcasts(chatId, user);
  }

  @Get('channels/:chatId/broadcasts/:broadcastId')
  getChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.getChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Put('channels/:chatId/broadcasts/:broadcastId')
  updateChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChannelManagedBroadcast(chatId, broadcastId, user, body);
  }

  @Delete('channels/:chatId/broadcasts/:broadcastId')
  cancelChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.cancelChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Post('channels/:chatId/broadcasts/:broadcastId/retry')
  retryChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.retryChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Get('channels/:chatId/poll')
  getChannelPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChannelPoll(chatId, user);
  }

  @Put('channels/:chatId/poll')
  updateChannelPoll(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChannelPoll(chatId, user, body);
  }

  @Post('channels/:chatId/poll/publish')
  publishChannelPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.publishChannelPoll(chatId, user);
  }

  @Post('channels/:chatId/poll/close')
  closeChannelPoll(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.closeChannelPoll(chatId, user);
  }

  @Get('channels/:chatId/dialog/suggest/redirect')
  getChannelSuggestionRedirect(
    @Param('chatId') chatId: string,
    @CurrentUser() _user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.adminService.getChannelSuggestionRedirect(chatId, token ?? null);
  }

  @Get('channels/:chatId/dialog/:dialogType')
  getChannelDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.adminService.getChannelDialog(chatId, user, dialogType, token ?? null);
  }

  @Post('channels/:chatId/dialog/:dialogType/messages')
  createChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.createChannelDialogMessage(chatId, user, dialogType, body);
  }

  @Patch('channels/:chatId/dialog/:dialogType/messages/:messageId')
  updateChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChannelDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Delete('channels/:chatId/dialog/:dialogType/messages/:messageId')
  deleteChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.deleteChannelDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Post('channels/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  toggleChannelDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.toggleChannelDialogReaction(chatId, user, dialogType, messageId, body);
  }

  @Get('chats/:chatId/dialog/:dialogType')
  getChatDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.adminService.getChatDialog(chatId, user, dialogType, token ?? null);
  }

  @Post('chats/:chatId/dialog/:dialogType/messages')
  createChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.createChatDialogMessage(chatId, user, dialogType, body);
  }

  @Patch('chats/:chatId/dialog/:dialogType/messages/:messageId')
  updateChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateChatDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Delete('chats/:chatId/dialog/:dialogType/messages/:messageId')
  deleteChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.deleteChatDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Post('chats/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  toggleChatDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.toggleChatDialogReaction(chatId, user, dialogType, messageId, body);
  }

  @Post('chats/:chatId/settings/apply-to-all')
  applySettingsToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.applySettingsToAllChats(chatId, user, body);
  }

  @Post('chats/:chatId/settings/apply-section-to-all')
  applySettingsSectionToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.applySettingsSectionToAllChats(chatId, user, body);
  }

  @Post('chats/:chatId/broadcast')
  sendBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.sendBroadcast(chatId, user, body);
  }

  @Get('chats/:chatId/broadcasts')
  getManagedBroadcasts(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.listManagedBroadcasts(chatId, user);
  }

  @Get('chats/:chatId/broadcasts/:broadcastId')
  getManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.getManagedBroadcast(chatId, broadcastId, user);
  }

  @Put('chats/:chatId/broadcasts/:broadcastId')
  updateManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.updateManagedBroadcast(chatId, broadcastId, user, body);
  }

  @Delete('chats/:chatId/broadcasts/:broadcastId')
  cancelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.cancelManagedBroadcast(chatId, broadcastId, user);
  }

  @Post('chats/:chatId/broadcasts/:broadcastId/retry')
  retryManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.retryManagedBroadcast(chatId, broadcastId, user);
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
    return this.adminService.getEvents(chatId, user, query);
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
    return this.adminService.getLogsDashboard(chatId, user, query);
  }

  @Post('chats/:chatId/members/:userId/moderation-action')
  applyManualModerationAction(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.applyManualModerationAction(chatId, targetUserId, user, body);
  }

  @Post('chats/:chatId/admin-allowlist')
  addAdmin(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.adminService.addAdmin(chatId, user, body);
  }

  @Delete('chats/:chatId/admin-allowlist/:userId')
  removeAdmin(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeAdmin(chatId, user, targetUserId);
  }

  @Post('chats/:chatId/domain-allowlist')
  addDomain(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.adminService.addDomain(chatId, user, body);
  }

  @Get('chats/:chatId/domain-allowlist')
  getDomainAllowlist(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getDomainAllowlist(chatId, user);
  }

  @Get('chats/:chatId/domain-allowlist/details')
  getDomainAllowlistDetails(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getDomainAllowlistDetails(chatId, user);
  }

  @Delete('chats/:chatId/domain-allowlist')
  removeDomainByQuery(
    @Param('chatId') chatId: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeDomain(chatId, user, this.resolveAllowlistDomain(domainQuery));
  }

  @Delete('chats/:chatId/domain-allowlist/:domain')
  removeDomain(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeDomain(
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
    return this.adminService.scheduleDomainRemoval(
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
    return this.adminService.scheduleDomainRemoval(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery, domain),
      body,
    );
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
