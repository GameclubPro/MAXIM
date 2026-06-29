import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedAutopostService } from './managed-autopost.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminAutopostController {
  constructor(private readonly autopostService: ManagedAutopostService) {}

  @Get('channels/:chatId/autopost-rules')
  getChannelAutopostRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.autopostService.listChannelAutopostRules(chatId, user);
  }

  @Post('channels/:chatId/autopost-rules')
  createChannelAutopostRule(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.autopostService.createChannelAutopostRule(chatId, user, body);
  }

  @Get('channels/:chatId/autopost-rules/:ruleId')
  getChannelAutopostRule(
    @Param('chatId') chatId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.autopostService.getChannelAutopostRule(chatId, ruleId, user);
  }

  @Put('channels/:chatId/autopost-rules/:ruleId')
  updateChannelAutopostRule(
    @Param('chatId') chatId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.autopostService.updateChannelAutopostRule(chatId, ruleId, user, body);
  }

  @Delete('channels/:chatId/autopost-rules/:ruleId')
  deleteChannelAutopostRule(
    @Param('chatId') chatId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.autopostService.deleteChannelAutopostRule(chatId, ruleId, user);
  }

  @Get('chats/:chatId/autopost-rules')
  getChatAutopostRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.autopostService.listChatAutopostRules(chatId, user);
  }

  @Post('chats/:chatId/autopost-rules')
  createChatAutopostRule(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.autopostService.createChatAutopostRule(chatId, user, body);
  }

  @Get('chats/:chatId/autopost-rules/:ruleId')
  getChatAutopostRule(
    @Param('chatId') chatId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.autopostService.getChatAutopostRule(chatId, ruleId, user);
  }

  @Put('chats/:chatId/autopost-rules/:ruleId')
  updateChatAutopostRule(
    @Param('chatId') chatId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.autopostService.updateChatAutopostRule(chatId, ruleId, user, body);
  }

  @Delete('chats/:chatId/autopost-rules/:ruleId')
  deleteChatAutopostRule(
    @Param('chatId') chatId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.autopostService.deleteChatAutopostRule(chatId, ruleId, user);
  }
}
