import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PrivateControlService } from './private-control.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class PrivateControlController {
  constructor(private readonly privateControlService: PrivateControlService) {}

  @Post('chats/:chatId/karavan-storefront/allowlist/handoff')
  handoffKaravanStorefrontAllowlist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.privateControlService.handoffKaravanStorefrontAllowlistFromMiniapp(chatId, user);
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
}
