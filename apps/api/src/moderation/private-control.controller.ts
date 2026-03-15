import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PrivateControlService } from './private-control.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class PrivateControlController {
  constructor(private readonly privateControlService: PrivateControlService) {}

  @Post('chats/:chatId/entrypoint')
  createChatEntrypoint(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.createSurfaceEntrypoint(chatId, user, body, 'chat');
  }

  @Post('channels/:chatId/entrypoint')
  createChannelEntrypoint(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.privateControlService.createSurfaceEntrypoint(chatId, user, body, 'channel');
  }

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
}
