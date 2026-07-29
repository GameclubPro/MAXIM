import type { ManagedEntityType } from '@maxim/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedPollService } from './managed-poll.service';

@Controller('v1/:entityCollection/:chatId/polls')
@UseGuards(InitDataGuard)
export class AdminPollController {
  constructor(private readonly managedPollService: ManagedPollService) {}

  @Get()
  list(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.managedPollService.listChannelPolls(
      chatId,
      user,
      query,
      this.resolveEntityType(entityCollection),
    );
  }

  @Post()
  create(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedPollService.createChannelPoll(
      chatId,
      user,
      body,
      this.resolveEntityType(entityCollection),
    );
  }

  @Get(':pollId')
  get(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.getChannelPoll(
      chatId,
      pollId,
      user,
      this.resolveEntityType(entityCollection),
    );
  }

  @Put(':pollId')
  update(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedPollService.updateChannelPoll(
      chatId,
      pollId,
      user,
      body,
      this.resolveEntityType(entityCollection),
    );
  }

  @Delete(':pollId')
  delete(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.deleteChannelPoll(
      chatId,
      pollId,
      user,
      this.resolveEntityType(entityCollection),
    );
  }

  @Post(':pollId/publish')
  publish(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.publishChannelPoll(
      chatId,
      pollId,
      user,
      this.resolveEntityType(entityCollection),
    );
  }

  @Post(':pollId/close')
  close(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.closeChannelPoll(
      chatId,
      pollId,
      user,
      this.resolveEntityType(entityCollection),
    );
  }

  @Post(':pollId/refresh')
  refresh(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.refreshChannelPollPublication(
      chatId,
      pollId,
      user,
      this.resolveEntityType(entityCollection),
    );
  }

  @Post(':pollId/reset-publication')
  resetPublication(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedPollService.resetChannelPollPublication(
      chatId,
      pollId,
      user,
      this.resolveEntityType(entityCollection),
    );
  }

  @Get(':pollId/voters')
  voters(
    @Param('entityCollection') entityCollection: string,
    @Param('chatId') chatId: string,
    @Param('pollId') pollId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.managedPollService.getChannelPollVoters(
      chatId,
      pollId,
      user,
      query,
      this.resolveEntityType(entityCollection),
    );
  }

  private resolveEntityType(entityCollection: string): ManagedEntityType {
    if (entityCollection === 'chats') {
      return 'chat';
    }
    if (entityCollection === 'channels') {
      return 'channel';
    }
    throw new NotFoundException('Раздел опросов не найден.');
  }
}
