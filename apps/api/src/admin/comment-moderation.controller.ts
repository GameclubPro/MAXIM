import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentMiniappProfile, MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ChannelDialogService } from './channel-dialog.service';
import { CommentModerationService } from './comment-moderation.service';
import { updateCommentRestrictionRequestSchema } from '@maxim/contracts/channel-dialog';

const querySchema = z.object({
  token: z.string().trim().min(16).max(256),
  cursor: z.string().max(191).optional(),
});

@Controller('v1/:entitySegment/:chatId/dialog/comments/moderation')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation', 'publisher')
export class CommentModerationController {
  constructor(
    private readonly dialogs: ChannelDialogService,
    private readonly moderation: CommentModerationService,
  ) {}

  private scope(segment: string, chatId: string, profile: MiniappProfile, token: string) {
    if (segment !== 'chats' && segment !== 'channels')
      throw new BadRequestException('Неизвестный тип сообщества.');
    const scope = {
      chatId,
      entityType: segment === 'channels' ? ('channel' as const) : ('chat' as const),
      profile,
    };
    const threadId = this.dialogs.resolveCommentThread(chatId, scope.entityType, token, profile);
    return { scope, threadId };
  }

  private query(value: unknown) {
    const parsed = querySchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    return parsed.data;
  }

  @Get()
  state(
    @Param('entitySegment') segment: string,
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @Query() query: unknown,
  ) {
    const { scope } = this.scope(segment, chatId, profile, this.query(query).token);
    return this.moderation.state(scope, user);
  }

  @Get('restrictions')
  list(
    @Param('entitySegment') segment: string,
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @Query() query: unknown,
  ) {
    const parsed = this.query(query);
    const { scope } = this.scope(segment, chatId, profile, parsed.token);
    return this.moderation.list(scope, user, parsed.cursor);
  }

  @Get('users/:userId')
  target(
    @Param('entitySegment') segment: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @Query() query: unknown,
  ) {
    const { scope } = this.scope(segment, chatId, profile, this.query(query).token);
    return this.moderation.target(scope, user, userId);
  }

  @Put('users/:userId')
  update(
    @Param('entitySegment') segment: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @Body() body: unknown,
  ) {
    const parsed = updateCommentRestrictionRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const { scope, threadId } = this.scope(segment, chatId, profile, parsed.data.token);
    return this.moderation.update(scope, user, userId, threadId, parsed.data);
  }
}
