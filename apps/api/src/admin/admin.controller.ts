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

  @Get('chats/:chatId/commercial-allowlist')
  getCommercialAllowlist(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getCommercialAllowlist(chatId, user);
  }

  @Post('chats/:chatId/commercial-allowlist')
  addCommercialAllowlist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.addCommercialAllowlist(chatId, user, body);
  }

  @Delete('chats/:chatId/commercial-allowlist/:phrase')
  removeCommercialAllowlist(
    @Param('chatId') chatId: string,
    @Param('phrase') phrase: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeCommercialAllowlist(chatId, user, phrase);
  }

  @Get('chats/:chatId/commercial-stoplist')
  getCommercialStoplist(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.adminService.getCommercialStoplist(chatId, user);
  }

  @Post('chats/:chatId/commercial-stoplist')
  addCommercialStoplist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.adminService.addCommercialStoplist(chatId, user, body);
  }

  @Delete('chats/:chatId/commercial-stoplist/:phrase')
  removeCommercialStoplist(
    @Param('chatId') chatId: string,
    @Param('phrase') phrase: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.removeCommercialStoplist(chatId, user, phrase);
  }
}
