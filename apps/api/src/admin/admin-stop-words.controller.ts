import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminStopWordsService } from './admin-stop-words.service';

@Controller('v1/chats/:chatId/stop-words')
@UseGuards(InitDataGuard)
export class AdminStopWordsController {
  constructor(private readonly service: AdminStopWordsService) {}

  @Get('status')
  status(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.service.status(chatId, user);
  }

  @Get()
  read(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.service.read(chatId, user);
  }

  @Put()
  update(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.service.update(chatId, user, body);
  }

  @Post('preview')
  preview(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.service.preview(chatId, user, body);
  }
}
