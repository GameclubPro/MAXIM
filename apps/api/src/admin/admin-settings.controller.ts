import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminSettingsService } from './admin-settings.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminSettingsController {
  constructor(private readonly settingsService: AdminSettingsService) {}

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
}
