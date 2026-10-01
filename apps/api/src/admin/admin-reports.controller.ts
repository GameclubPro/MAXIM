import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminReportsService } from './admin-reports.service';
import { ManagedEntitiesService } from './managed-entities.service';

@Controller('v1/chats/:chatId/reports')
@UseGuards(InitDataGuard)
export class AdminReportsController {
  constructor(
    private readonly access: ManagedEntitiesService,
    private readonly reports: AdminReportsService,
  ) {}
  @Get()
  async list(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
    @Query('authorId') authorId?: unknown,
  ) {
    await this.access.assertChatAdminAccess(chatId, user);
    return this.reports.list(chatId, cursor, {
      ...(status !== undefined ? { status } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(authorId !== undefined ? { authorId } : {}),
    });
  }
  @Get('availability')
  async availability(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    await this.access.assertChatAdminAccess(chatId, user);
    return this.reports.availability(chatId);
  }
  @Get(':reportId')
  async detail(
    @Param('chatId') chatId: string,
    @Param('reportId') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertChatAdminAccess(chatId, user);
    return this.reports.detail(chatId, id);
  }
  @Post(':reportId/dismiss')
  async dismiss(
    @Param('chatId') chatId: string,
    @Param('reportId') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertChatAdminAccess(chatId, user);
    return this.reports.dismiss(chatId, id, user.userId);
  }
}
