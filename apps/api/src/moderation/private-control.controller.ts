import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PrivateControlService } from './private-control.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class PrivateControlController {
  constructor(private readonly privateControlService: PrivateControlService) {}

  @Post('chats/:chatId/broadcast/handoff')
  handoffChatBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffBroadcastFromMiniapp(chatId, user, body, 'chat');
  }

  @Post('channels/:chatId/broadcast/handoff')
  handoffChannelBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffBroadcastFromMiniapp(chatId, user, body, 'channel');
  }

  @Get('chats/:chatId/broadcast/handoff')
  getChatBroadcastHandoff(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.privateControlService.getBroadcastHandoffState(chatId, user, 'chat');
  }

  @Delete('chats/:chatId/broadcast/handoff')
  clearChatBroadcastHandoff(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.privateControlService.clearBroadcastHandoffState(chatId, user, 'chat');
  }

  @Get('channels/:chatId/broadcast/handoff')
  getChannelBroadcastHandoff(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.privateControlService.getBroadcastHandoffState(chatId, user, 'channel');
  }

  @Delete('channels/:chatId/broadcast/handoff')
  clearChannelBroadcastHandoff(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.privateControlService.clearBroadcastHandoffState(chatId, user, 'channel');
  }

  @Post('chats/:chatId/rules/handoff')
  handoffChatRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.privateControlService.handoffRulesFromMiniapp(chatId, user);
  }

  @Post('chats/:chatId/giveaway/handoff')
  handoffChatGiveaway(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffGiveawayFromMiniapp(chatId, user, body, 'chat');
  }

  @Post('channels/:chatId/giveaway/handoff')
  handoffChannelGiveaway(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffGiveawayFromMiniapp(chatId, user, body, 'channel');
  }

  @Post('chats/:chatId/members/:userId/profile/handoff')
  handoffChatMemberProfile(
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffProfileMentionFromMiniapp(
      chatId,
      user,
      userId,
      body,
      'chat',
    );
  }

  @Post('channels/:chatId/members/:userId/profile/handoff')
  handoffChannelMemberProfile(
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffProfileMentionFromMiniapp(
      chatId,
      user,
      userId,
      body,
      'channel',
    );
  }

  @Post('chats/:chatId/dialog/comments/attachments/handoff')
  handoffChatCommentAttachments(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffDialogCommentAttachmentsFromMiniapp(
      chatId,
      user,
      body,
      'chat',
    );
  }

  @Post('channels/:chatId/dialog/comments/attachments/handoff')
  handoffChannelCommentAttachments(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.handoffDialogCommentAttachmentsFromMiniapp(
      chatId,
      user,
      body,
      'channel',
    );
  }

  @Get('chats/:chatId/dialog/comments/attachments/handoff')
  getChatCommentAttachmentHandoffState(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.privateControlService.getDialogCommentAttachmentHandoffState(
      chatId,
      user,
      token ?? '',
      'chat',
    );
  }

  @Get('channels/:chatId/dialog/comments/attachments/handoff')
  getChannelCommentAttachmentHandoffState(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.privateControlService.getDialogCommentAttachmentHandoffState(
      chatId,
      user,
      token ?? '',
      'channel',
    );
  }

  @Delete('chats/:chatId/dialog/comments/attachments/handoff')
  clearChatCommentAttachmentHandoffState(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.privateControlService.clearDialogCommentAttachmentHandoffState(
      chatId,
      user,
      token ?? '',
      'chat',
    );
  }

  @Delete('channels/:chatId/dialog/comments/attachments/handoff')
  clearChannelCommentAttachmentHandoffState(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.privateControlService.clearDialogCommentAttachmentHandoffState(
      chatId,
      user,
      token ?? '',
      'channel',
    );
  }
}
