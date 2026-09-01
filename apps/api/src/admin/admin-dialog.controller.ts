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
import { CurrentMiniappProfile, MiniappProfiles } from '../auth/miniapp-profile';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { MiniappProfileForbiddenException } from '../auth/miniapp-profile.error';
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
  @MiniappProfiles('moderation', 'publisher')
  getChannelDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChannelDialogProfile(profile, dialogType);
    return this.dialogService.getChannelDialog(chatId, user, dialogType, token ?? null, profile);
  }

  @Post('channels/:chatId/dialog/:dialogType/messages')
  @MiniappProfiles('moderation', 'publisher')
  createChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChannelDialogProfile(profile, dialogType);
    return this.dialogService.createChannelDialogMessage(chatId, user, dialogType, body, profile);
  }

  @Put('channels/:chatId/dialog/:dialogType/notifications')
  @MiniappProfiles('moderation', 'publisher')
  updateChannelDialogNotifications(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChannelDialogProfile(profile, dialogType);
    return this.dialogService.updateChannelDialogNotifications(
      chatId,
      user,
      dialogType,
      body,
      profile,
    );
  }

  @Patch('channels/:chatId/dialog/:dialogType/messages/:messageId')
  @MiniappProfiles('moderation', 'publisher')
  updateChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChannelDialogProfile(profile, dialogType);
    return this.dialogService.updateChannelDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  @Delete('channels/:chatId/dialog/:dialogType/messages/:messageId')
  @MiniappProfiles('moderation', 'publisher')
  deleteChannelDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChannelDialogProfile(profile, dialogType);
    return this.dialogService.deleteChannelDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  @Post('channels/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  @MiniappProfiles('moderation', 'publisher')
  toggleChannelDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChannelDialogProfile(profile, dialogType);
    return this.dialogService.toggleChannelDialogReaction(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  @Get('chats/:chatId/dialog/:dialogType')
  @MiniappProfiles('moderation', 'publisher')
  getChatDialog(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Query('token') token: string | undefined,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChatDialogProfile(profile, dialogType);
    return this.dialogService.getChatDialog(chatId, user, dialogType, token ?? null, profile);
  }

  @Post('chats/:chatId/dialog/:dialogType/messages')
  @MiniappProfiles('moderation', 'publisher')
  createChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChatDialogProfile(profile, dialogType);
    return this.dialogService.createChatDialogMessage(chatId, user, dialogType, body, profile);
  }

  @Put('chats/:chatId/dialog/:dialogType/notifications')
  @MiniappProfiles('moderation', 'publisher')
  updateChatDialogNotifications(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChatDialogProfile(profile, dialogType);
    return this.dialogService.updateChatDialogNotifications(
      chatId,
      user,
      dialogType,
      body,
      profile,
    );
  }

  @Patch('chats/:chatId/dialog/:dialogType/messages/:messageId')
  @MiniappProfiles('moderation', 'publisher')
  updateChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChatDialogProfile(profile, dialogType);
    return this.dialogService.updateChatDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  @Delete('chats/:chatId/dialog/:dialogType/messages/:messageId')
  @MiniappProfiles('moderation', 'publisher')
  deleteChatDialogMessage(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChatDialogProfile(profile, dialogType);
    return this.dialogService.deleteChatDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  @Post('chats/:chatId/dialog/:dialogType/messages/:messageId/reactions')
  @MiniappProfiles('moderation', 'publisher')
  toggleChatDialogReaction(
    @Param('chatId') chatId: string,
    @Param('dialogType') dialogType: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    this.assertChatDialogProfile(profile, dialogType);
    return this.dialogService.toggleChatDialogReaction(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  private assertChatDialogProfile(profile: MiniappProfile, dialogType: string): void {
    if (profile === 'publisher' && dialogType !== 'comments') {
      throw new MiniappProfileForbiddenException();
    }
  }

  private assertChannelDialogProfile(profile: MiniappProfile, dialogType: string): void {
    if (profile === 'publisher' && dialogType !== 'suggest' && dialogType !== 'comments') {
      throw new MiniappProfileForbiddenException();
    }
  }
}
