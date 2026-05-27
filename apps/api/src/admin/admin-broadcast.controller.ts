import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedBroadcastService } from './managed-broadcast.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminBroadcastController {
  constructor(private readonly broadcastService: ManagedBroadcastService) {}

  @Post('channels/:chatId/broadcast')
  sendChannelBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendChannelBroadcast(chatId, user, body);
  }

  @Post('channels/:chatId/broadcast/test')
  sendChannelBroadcastTest(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendChannelBroadcastTest(chatId, user, body);
  }

  @Get('channels/:chatId/broadcast-calendar')
  getChannelManagedBroadcastCalendar(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.broadcastService.getChannelManagedBroadcastCalendar(chatId, user, query);
  }

  @Get('channels/:chatId/broadcasts')
  getChannelManagedBroadcasts(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.broadcastService.listChannelManagedBroadcasts(chatId, user);
  }

  @Get('channels/:chatId/broadcasts/:broadcastId')
  getChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.getChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Put('channels/:chatId/broadcasts/:broadcastId')
  updateChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.updateChannelManagedBroadcast(chatId, broadcastId, user, body);
  }

  @Delete('channels/:chatId/broadcasts/:broadcastId')
  cancelChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.cancelChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Post('channels/:chatId/broadcasts/:broadcastId/retry')
  retryChannelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.retryChannelManagedBroadcast(chatId, broadcastId, user);
  }

  @Post('chats/:chatId/broadcast')
  sendBroadcast(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendBroadcast(chatId, user, body);
  }

  @Post('chats/:chatId/broadcast/test')
  sendBroadcastTest(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.sendBroadcastTest(chatId, user, body);
  }

  @Get('chats/:chatId/broadcast-calendar')
  getManagedBroadcastCalendar(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.broadcastService.getManagedBroadcastCalendar(chatId, user, query);
  }

  @Get('chats/:chatId/broadcasts')
  getManagedBroadcasts(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.broadcastService.listManagedBroadcasts(chatId, user);
  }

  @Get('chats/:chatId/broadcasts/:broadcastId')
  getManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.getManagedBroadcast(chatId, broadcastId, user);
  }

  @Put('chats/:chatId/broadcasts/:broadcastId')
  updateManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.broadcastService.updateManagedBroadcast(chatId, broadcastId, user, body);
  }

  @Delete('chats/:chatId/broadcasts/:broadcastId')
  cancelManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.cancelManagedBroadcast(chatId, broadcastId, user);
  }

  @Post('chats/:chatId/broadcasts/:broadcastId/retry')
  retryManagedBroadcast(
    @Param('chatId') chatId: string,
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.broadcastService.retryManagedBroadcast(chatId, broadcastId, user);
  }
}
