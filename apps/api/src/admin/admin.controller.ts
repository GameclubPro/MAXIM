import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.adminService.getMe(user);
  }

  @Get('chats')
  getChats(@CurrentUser() user: AuthUser) {
    return this.adminService.listChats(user);
  }

  @Get('chats/:chatId/header')
  getChatHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getChatHeader(chatId, user);
  }

  @Get('channels')
  getChannels(@CurrentUser() user: AuthUser) {
    return this.adminService.listChannels(user);
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

  @Get('chats/:chatId/settings')
  getSettings(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getSettings(chatId, user);
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

  @Post('chats/:chatId/settings/apply-to-all')
  applySettingsToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.applySettingsToAllChats(chatId, user, body);
  }

  @Post('chats/:chatId/broadcast')
  sendBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.sendBroadcast(chatId, user, body);
  }

  @Get('chats/:chatId/moderation-events')
  getEvents(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.adminService.getEvents(chatId, user, query);
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

  @Get('chats/:chatId/global-user-blacklist')
  getGlobalUserBlacklist(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getGlobalUserBlacklist(chatId, user);
  }

  @Post('chats/:chatId/global-user-blacklist')
  addGlobalUserBlacklistUser(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.addGlobalUserBlacklistUser(chatId, user, body);
  }

  @Delete('chats/:chatId/global-user-blacklist/:userId')
  removeGlobalUserBlacklistUser(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeGlobalUserBlacklistUser(chatId, user, targetUserId);
  }
}
