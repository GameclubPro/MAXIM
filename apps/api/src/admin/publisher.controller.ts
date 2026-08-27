import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts/publisher';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublisherEntityRefreshService } from './publisher-entity-refresh.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';

@Controller('v1/publisher')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublisherController {
  constructor(
    private readonly policyService: PublisherPolicyService,
    private readonly entityRefreshService: PublisherEntityRefreshService,
    private readonly suggestionService: PublisherSuggestionService,
  ) {}

  @Get('entities')
  listEntities(@CurrentUser() user: AuthUser, @Query() query?: unknown) {
    return this.policyService.listEntities(user, query);
  }

  @Get('entities/:entityType/:entityId')
  getEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.policyService.getEntity(this.parseEntityType(entityType), entityId, user);
  }

  @Post('entities/resolve')
  resolveEntities(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.policyService.resolveEntities(user, body);
  }

  @Get('entities/channel/:entityId/suggestions')
  listSuggestions(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.suggestionService.list(entityId, user);
  }

  @Post('entities/channel/:entityId/suggestions/:suggestionId/review')
  reviewSuggestion(
    @Param('entityId') entityId: string,
    @Param('suggestionId') suggestionId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.suggestionService.review(entityId, suggestionId, user, body);
  }

  @Post('entities/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshEntities(@CurrentUser() user: AuthUser) {
    return this.entityRefreshService.requestBulkRefresh(user);
  }

  @Get('entities/:entityType/:entityId/policy')
  @MiniappProfiles('moderation')
  getPolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.policyService.getPolicyForModeration(
      this.parseEntityType(entityType),
      entityId,
      user,
    );
  }

  @Patch('entities/:entityType/:entityId/policy')
  @MiniappProfiles('moderation')
  updatePolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.policyService.updatePolicy(
      this.parseEntityType(entityType),
      entityId,
      user,
      body,
    );
  }

  @Patch('entities/:entityType/:entityId/modules')
  updateModules(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.policyService.updateModuleSettings(
      this.parseEntityType(entityType),
      entityId,
      user,
      body,
    );
  }

  @Post('entities/:entityType/:entityId/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.entityRefreshService.requestRefresh(
      this.parseEntityType(entityType),
      entityId,
      user,
    );
  }

  private parseEntityType(value: string): ManagedEntityType {
    if (value === 'chat' || value === 'channel') {
      return value;
    }
    throw new BadRequestException('Unsupported managed entity type');
  }
}
