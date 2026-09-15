import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { VkBotReviewService } from './vk-bot-review.service';

@Controller('v1/publisher/entities/channel/:entityId/vk-parsing/bot-review')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublisherVkBotReviewController {
  constructor(private readonly reviews: VkBotReviewService) {}

  @Get()
  get(@Param('entityId') entityId: string, @CurrentUser() user: AuthUser) {
    return this.reviews.getState(entityId, user);
  }

  @Patch()
  update(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.reviews.configure(entityId, user, body);
  }

  @Post('posts/:postId')
  submit(
    @Param('entityId') entityId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reviews.submitPost(entityId, postId, user);
  }
}
