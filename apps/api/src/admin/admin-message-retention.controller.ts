import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminMessageRetentionService } from './admin-message-retention.service';

@Controller('v1/chats/:chatId/message-retention')
@UseGuards(InitDataGuard)
export class AdminMessageRetentionController {
  constructor(private readonly service: AdminMessageRetentionService) {}
  @Get()
  read(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.service.read(chatId, user);
  }
  @Get('status')
  status(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.service.read(chatId, user);
  }
  @Put()
  update(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.service.update(chatId, user, body);
  }
}
