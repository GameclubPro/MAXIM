import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { VkParsingService } from './vk-parsing.service';

@Controller('v1/publisher/entities/:entityType/:entityId/vk-parsing')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublisherVkParsingController {
  constructor(private readonly vkParsingService: VkParsingService) {}

  @Get()
  getVkParsing(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.vkParsingService.listVkParsing(this.parseEntityId(entityType, entityId), user, query);
  }

  @Get('capability')
  getVkParsingCapability(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.getCapability(this.parseEntityId(entityType, entityId), user);
  }

  @Patch('settings')
  updateVkParsingSettings(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateSettings(
      this.parseEntityId(entityType, entityId),
      user,
      body,
    );
  }

  @Get('autopublish/dry-run')
  dryRunVkParsingAutopublish(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.vkParsingService.dryRunAutoPublish(
      this.parseEntityId(entityType, entityId),
      user,
      query,
    );
  }

  @Post('rollback')
  rollbackVkParsingAutopublish(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.rollbackAutoPublished(
      this.parseEntityId(entityType, entityId),
      user,
      body,
    );
  }

  @Post('sources/bulk')
  applyVkParsingSourcePreset(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.applySourcePreset(
      this.parseEntityId(entityType, entityId),
      user,
      body,
    );
  }

  @Post('sources')
  addVkParsingSource(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.addSource(this.parseEntityId(entityType, entityId), user, body);
  }

  @Patch('sources/:sourceId')
  updateVkParsingSource(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateSource(
      this.parseEntityId(entityType, entityId),
      sourceId,
      user,
      body,
    );
  }

  @Post('sources/:sourceId/refresh')
  refreshVkParsingSource(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.refreshSource(
      this.parseEntityId(entityType, entityId),
      sourceId,
      user,
    );
  }

  @Delete('sources/:sourceId')
  removeVkParsingSource(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.removeSource(
      this.parseEntityId(entityType, entityId),
      sourceId,
      user,
    );
  }

  @Post('refresh')
  refreshVkParsing(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.refresh(this.parseEntityId(entityType, entityId), user);
  }

  @Get('summary')
  getVkParsingSummary(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.getHealthSummary(this.parseEntityId(entityType, entityId), user);
  }

  @Post('posts/:postId/retry')
  retryVkParsingPost(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.retryPost(
      this.parseEntityId(entityType, entityId),
      postId,
      user,
    );
  }

  @Patch('posts/:postId/schedule')
  scheduleVkParsingPost(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.schedulePost(
      this.parseEntityId(entityType, entityId),
      postId,
      user,
      body,
    );
  }

  @Post('posts/:postId/cancel')
  cancelVkParsingPost(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.cancelScheduledPost(
      this.parseEntityId(entityType, entityId),
      postId,
      user,
    );
  }

  @Post('posts/:postId/publish-now')
  publishVkParsingPostNow(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.vkParsingService.publishPostNow(
      this.parseEntityId(entityType, entityId),
      postId,
      user,
    );
  }

  @Post('posts/:postId/publish')
  @HttpCode(HttpStatus.ACCEPTED)
  publishVkParsingPost(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.publishPost(
      this.parseEntityId(entityType, entityId),
      postId,
      user,
      body,
    );
  }

  @Patch('posts/:postId/review-draft')
  updateVkParsingReviewDraft(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.vkParsingService.updateReviewPostDraft(
      this.parseEntityId(entityType, entityId),
      postId,
      user,
      body,
    );
  }

  private parseEntityId(entityType: string, entityId: string): string {
    if (entityType !== 'chat' && entityType !== 'channel') {
      throw new BadRequestException('Unsupported managed entity type');
    }
    return entityId;
  }
}
