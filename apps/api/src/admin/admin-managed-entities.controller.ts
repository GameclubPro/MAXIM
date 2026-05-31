import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedEntitiesService } from './managed-entities.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminManagedEntitiesController {
  constructor(private readonly entitiesService: ManagedEntitiesService) {}

  @Get('me')
  me(
    @CurrentUser() user: AuthUser,
    @Query('chatId') chatId: string | undefined,
    @Query('entityType') entityType: string | undefined,
  ) {
    return this.entitiesService.getMe(user, {
      chatId,
      entityType: entityType === 'channel' ? 'channel' : entityType === 'chat' ? 'chat' : undefined,
      enrichFromMax: Boolean(chatId?.trim()),
    });
  }

  @Get('chats')
  getChats(
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
    @Query('includeRefreshState') includeRefreshState: string | undefined,
    @Query('bypassCache') bypassCache: string | undefined,
    @Query('fresh') fresh: string | undefined,
    @Query('resetCursor') resetCursor: string | undefined,
    @Query('sinceVersion') sinceVersion: string | undefined,
  ) {
    const options = {
      refresh: refresh === '1',
      fresh: fresh === '1',
      bypassRemoteCache: bypassCache === '1',
      resetRefreshCursor: resetCursor === '1',
      sinceVersion,
    };
    if (includeRefreshState === '1') {
      return this.entitiesService.listChatsWithRefreshState(user, options);
    }

    return this.entitiesService.listChats(user, options);
  }

  @Get('chats/:chatId/header')
  getChatHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.entitiesService.getChatHeader(chatId, user);
  }

  @Get('chats/:chatId/bots/plan')
  getChatBotExecutionPlan(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.entitiesService.getChatBotExecutionPlan(chatId, user, {
      refresh: refresh === '1',
    });
  }

  @Post('chats/:chatId/bots/primary')
  updateChatPrimaryBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChatPrimaryBot(chatId, user, body);
  }

  @Post('chats/:chatId/bots/partner-assist')
  updateChatPartnerAssist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChatPartnerAssist(chatId, user, body);
  }

  @Post('chats/:chatId/bots/promote-standby')
  promoteChatStandbyBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.promoteChatStandbyBot(chatId, user, body);
  }

  @Get('channels')
  getChannels(
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
    @Query('includeRefreshState') includeRefreshState: string | undefined,
    @Query('bypassCache') bypassCache: string | undefined,
    @Query('fresh') fresh: string | undefined,
    @Query('resetCursor') resetCursor: string | undefined,
    @Query('sinceVersion') sinceVersion: string | undefined,
  ) {
    const options = {
      refresh: refresh === '1',
      fresh: fresh === '1',
      bypassRemoteCache: bypassCache === '1',
      resetRefreshCursor: resetCursor === '1',
      sinceVersion,
    };
    if (includeRefreshState === '1') {
      return this.entitiesService.listChannelsWithRefreshState(user, options);
    }

    return this.entitiesService.listChannels(user, options);
  }

  @Get('channels/:chatId/header')
  getChannelHeader(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.entitiesService.getChannelHeader(chatId, user);
  }

  @Put('managed-entities/:entityType/:entityId/favorites')
  updateManagedEntityFavorites(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateManagedEntityFavorites(entityType, entityId, user, body);
  }

  @Post('managed-entities/:entityType/:entityId/access/recheck')
  recheckManagedEntityAccess(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.entitiesService.recheckManagedEntityAccess(entityType, entityId, user);
  }

  @Get('channels/:chatId/bots/plan')
  getChannelBotExecutionPlan(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.entitiesService.getChannelBotExecutionPlan(chatId, user, {
      refresh: refresh === '1',
    });
  }

  @Post('channels/:chatId/bots/primary')
  updateChannelPrimaryBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChannelPrimaryBot(chatId, user, body);
  }

  @Post('channels/:chatId/bots/partner-assist')
  updateChannelPartnerAssist(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.updateChannelPartnerAssist(chatId, user, body);
  }

  @Post('channels/:chatId/bots/promote-standby')
  promoteChannelStandbyBot(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.entitiesService.promoteChannelStandbyBot(chatId, user, body);
  }
}
