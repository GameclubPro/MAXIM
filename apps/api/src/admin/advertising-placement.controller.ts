import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdvertisingPlacementService } from './advertising-placement.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdvertisingPlacementController {
  constructor(private readonly service: AdvertisingPlacementService) {}

  @Get('advertising-placement/capability')
  capability(@CurrentUser() user: AuthUser) {
    return { available: this.service.isPilot(user) };
  }

  @Get('chats/:chatId/advertising-placement')
  state(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.service.state(chatId, user);
  }

  @Put('chats/:chatId/advertising-placement')
  update(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.service.update(chatId, user, body);
  }

  @Post('chats/:chatId/advertising-placement/send')
  send(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.service.send(chatId, user, body);
  }
}
