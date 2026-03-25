import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
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
  ) {
    if (includeRefreshState === '1') {
      return this.adminService.listChatsWithRefreshState(user, { refresh: refresh === '1' });
    }

    return this.adminService.listChats(user, { refresh: refresh === '1' });
  }

  @Get('chats/:chatId/header')
  getChatHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChatHeader(chatId, user);
  }

  @Get('channels')
  getChannels(
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
    @Query('includeRefreshState') includeRefreshState: string | undefined,
  ) {
    if (includeRefreshState === '1') {
      return this.adminService.listChannelsWithRefreshState(user, { refresh: refresh === '1' });
    }

    return this.adminService.listChannels(user, { refresh: refresh === '1' });
  }

  @Get('channels/:chatId/header')
  getChannelHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChannelHeader(chatId, user);
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

  @Delete('chats/:chatId/domain-allowlist/:domain')
  removeDomain(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeDomain(chatId, user, domain);
  }

  @Put('chats/:chatId/domain-allowlist/:domain/removal-schedule')
  scheduleDomainRemoval(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.scheduleDomainRemoval(chatId, user, domain, body);
  }
}
