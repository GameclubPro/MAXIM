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

  @Post('chats/:chatId/settings/apply-to-all')
  applySettingsToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.applySettingsToAllChats(chatId, user, body);
  }

  @Get('chats/:chatId/moderation-events')
  getEvents(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.adminService.getEvents(chatId, user, query);
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

  @Delete('chats/:chatId/domain-allowlist/:domain')
  removeDomain(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeDomain(chatId, user, domain);
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
