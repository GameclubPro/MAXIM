import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { VkParsingService } from './vk-parsing.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminVkParsingController {
  constructor(private readonly vkParsingService: VkParsingService) {}

  @Get('channels/:chatId/vk-parsing')
  getChannelVkParsing(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.vkParsingService.listVkParsing(chatId, user, query);
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

  @Get('channels/:chatId/vk-parsing/summary')
  getChannelVkParsingSummary(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.getHealthSummary(chatId, user);
  }

  @Post('channels/:chatId/vk-parsing/posts/:postId/retry')
  retryChannelVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.retryPost(chatId, postId, user);
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

  @Get('chats/:chatId/vk-parsing')
  getChatVkParsing(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.vkParsingService.listVkParsing(chatId, user, query);
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

  @Get('chats/:chatId/vk-parsing/summary')
  getChatVkParsingSummary(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.vkParsingService.getHealthSummary(chatId, user);
  }

  @Post('chats/:chatId/vk-parsing/posts/:postId/retry')
  retryChatVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.retryPost(chatId, postId, user);
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
}
