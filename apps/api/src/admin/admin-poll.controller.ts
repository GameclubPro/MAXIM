import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedPollService } from './managed-poll.service';

@Controller('v1/channels/:chatId/polls')
@UseGuards(InitDataGuard)
export class AdminPollController {
  constructor(private readonly managedPollService: ManagedPollService) {}

  @Get()
  list(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.managedPollService.listChannelPolls(chatId, user, query);
  }

  @Post()
  create(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.managedPollService.createChannelPoll(chatId, user, body);
  }

  @Get(':pollId')
  get(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.getChannelPoll(chatId, pollId, user);
  }

  @Put(':pollId')
  update(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedPollService.updateChannelPoll(chatId, pollId, user, body);
  }

  @Delete(':pollId')
  delete(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.deleteChannelPoll(chatId, pollId, user);
  }

  @Post(':pollId/publish')
  publish(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.publishChannelPoll(chatId, pollId, user);
  }

  @Post(':pollId/close')
  close(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.closeChannelPoll(chatId, pollId, user);
  }

  @Post(':pollId/refresh')
  refresh(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.refreshChannelPollPublication(chatId, pollId, user);
  }

  @Post(':pollId/reset-publication')
  resetPublication(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.resetChannelPollPublication(chatId, pollId, user);
  }

  @Get(':pollId/voters')
  voters(
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.managedPollService.getChannelPollVoters(chatId, pollId, user, query);
  }
}
