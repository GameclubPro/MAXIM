import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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

  @Get('channels/:chatId/vk-parsing/autopublish/dry-run')
  dryRunChannelVkParsingAutopublish(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.vkParsingService.dryRunAutoPublish(chatId, user, query);
  }

  @Post('channels/:chatId/vk-parsing/rollback')
  rollbackChannelVkParsingAutopublish(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.rollbackAutoPublished(chatId, user, body);
  }

  @Post('channels/:chatId/vk-parsing/sources/bulk')
  applyChannelVkParsingSourcePreset(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.applySourcePreset(chatId, user, body);
  }

  @Post('channels/:chatId/vk-parsing/sources')
  addChannelVkParsingSource(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.addSource(chatId, user, body);
  }

  @Patch('channels/:chatId/vk-parsing/sources/:sourceId')
  updateChannelVkParsingSource(
    @Param('chatId') chatId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateSource(chatId, sourceId, user, body);
  }

  @Post('channels/:chatId/vk-parsing/sources/:sourceId/refresh')
  refreshChannelVkParsingSource(
    @Param('chatId') chatId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.refreshSource(chatId, sourceId, user);
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

  @Patch('channels/:chatId/vk-parsing/posts/:postId/schedule')
  scheduleChannelVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.schedulePost(chatId, postId, user, body);
  }

  @Post('channels/:chatId/vk-parsing/posts/:postId/cancel')
  cancelChannelVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.cancelScheduledPost(chatId, postId, user);
  }

  @Post('channels/:chatId/vk-parsing/posts/:postId/publish-now')
  publishChannelVkParsingPostNow(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.publishPostNow(chatId, postId, user);
  }

  @Post('channels/:chatId/vk-parsing/posts/:postId/publish')
  @HttpCode(HttpStatus.ACCEPTED)
  publishChannelVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.publishPost(chatId, postId, user, body);
  }

  @Patch('channels/:chatId/vk-parsing/posts/:postId/review-draft')
  updateChannelVkParsingReviewDraft(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateReviewPostDraft(chatId, postId, user, body);
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

  @Get('chats/:chatId/vk-parsing/autopublish/dry-run')
  dryRunChatVkParsingAutopublish(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.vkParsingService.dryRunAutoPublish(chatId, user, query);
  }

  @Post('chats/:chatId/vk-parsing/rollback')
  rollbackChatVkParsingAutopublish(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.rollbackAutoPublished(chatId, user, body);
  }

  @Post('chats/:chatId/vk-parsing/sources/bulk')
  applyChatVkParsingSourcePreset(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.applySourcePreset(chatId, user, body);
  }

  @Post('chats/:chatId/vk-parsing/sources')
  addChatVkParsingSource(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.addSource(chatId, user, body);
  }

  @Patch('chats/:chatId/vk-parsing/sources/:sourceId')
  updateChatVkParsingSource(
    @Param('chatId') chatId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateSource(chatId, sourceId, user, body);
  }

  @Post('chats/:chatId/vk-parsing/sources/:sourceId/refresh')
  refreshChatVkParsingSource(
    @Param('chatId') chatId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.refreshSource(chatId, sourceId, user);
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

  @Patch('chats/:chatId/vk-parsing/posts/:postId/schedule')
  scheduleChatVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.schedulePost(chatId, postId, user, body);
  }

  @Post('chats/:chatId/vk-parsing/posts/:postId/cancel')
  cancelChatVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.cancelScheduledPost(chatId, postId, user);
  }

  @Post('chats/:chatId/vk-parsing/posts/:postId/publish-now')
  publishChatVkParsingPostNow(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.publishPostNow(chatId, postId, user);
  }

  @Post('chats/:chatId/vk-parsing/posts/:postId/publish')
  @HttpCode(HttpStatus.ACCEPTED)
  publishChatVkParsingPost(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.publishPost(chatId, postId, user, body);
  }

  @Patch('chats/:chatId/vk-parsing/posts/:postId/review-draft')
  updateChatVkParsingReviewDraft(
    @Param('chatId') chatId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateReviewPostDraft(chatId, postId, user, body);
  }
}
