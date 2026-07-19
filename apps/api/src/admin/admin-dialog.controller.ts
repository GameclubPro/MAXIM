import {
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
import { ChannelDialogService } from './channel-dialog.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminDialogController {
  constructor(private readonly dialogService: ChannelDialogService) {}

  @Get('channels/:chatId/dialog/suggest/redirect')
  getChannelSuggestionRedirect(
    @Param('chatId') chatId: string,
    @CurrentUser() _user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.dialogService.getChannelSuggestionRedirect(chatId, token ?? null);
  }

  @Get('channels/:chatId/dialog/:dialogType')
  getChannelDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.dialogService.getChannelDialog(chatId, user, dialogType, token ?? null);
  }

  @Post('channels/:chatId/dialog/:dialogType/messages')
  createChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.createChannelDialogMessage(chatId, user, dialogType, body);
  }

  @Put('channels/:chatId/dialog/:dialogType/notifications')
  updateChannelDialogNotifications(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.updateChannelDialogNotifications(chatId, user, dialogType, body);
  }

  @Patch('channels/:chatId/dialog/:dialogType/messages/:messageId')
  updateChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.updateChannelDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Delete('channels/:chatId/dialog/:dialogType/messages/:messageId')
  deleteChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.deleteChannelDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Post('channels/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  toggleChannelDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.toggleChannelDialogReaction(
      chatId,
      user,
      dialogType,
      messageId,
      body,
    );
  }

  @Get('chats/:chatId/dialog/:dialogType')
  getChatDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
  ) {
    return this.dialogService.getChatDialog(chatId, user, dialogType, token ?? null);
  }

  @Post('chats/:chatId/dialog/:dialogType/messages')
  createChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.createChatDialogMessage(chatId, user, dialogType, body);
  }

  @Put('chats/:chatId/dialog/:dialogType/notifications')
  updateChatDialogNotifications(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.updateChatDialogNotifications(chatId, user, dialogType, body);
  }

  @Patch('chats/:chatId/dialog/:dialogType/messages/:messageId')
  updateChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.updateChatDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Delete('chats/:chatId/dialog/:dialogType/messages/:messageId')
  deleteChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.deleteChatDialogMessage(chatId, user, dialogType, messageId, body);
  }

  @Post('chats/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  toggleChatDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.dialogService.toggleChatDialogReaction(chatId, user, dialogType, messageId, body);
  }
}
