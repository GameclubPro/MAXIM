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
import type { ManagedEntityType, MiniappProfile } from '@maxim/contracts/publisher';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentMiniappProfile, MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublisherEntityRefreshService } from './publisher-entity-refresh.service';
import { PublisherPolicyService } from './publisher-policy.service';

@Controller('v1/publisher')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation', 'publisher')
export class PublisherController {
  constructor(
    private readonly policyService: PublisherPolicyService,
    private readonly entityRefreshService: PublisherEntityRefreshService,
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
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    const parsedEntityType = this.parseEntityType(entityType);
    return profile === 'moderation'
      ? this.policyService.getEntityForPolicy(parsedEntityType, entityId, user)
      : this.policyService.getEntity(parsedEntityType, entityId, user);
  }

  @Post('entities/resolve')
  resolveEntities(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.policyService.resolveEntities(user, body);
  }

  @Post('entities/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshEntities(@CurrentUser() user: AuthUser) {
    return this.entityRefreshService.requestBulkRefresh(user);
  }

  @Get('entities/:entityType/:entityId/policy')
  getPolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    const parsedEntityType = this.parseEntityType(entityType);
    const entity =
      profile === 'moderation'
        ? this.policyService.getEntityForPolicy(parsedEntityType, entityId, user)
        : this.policyService.getEntity(parsedEntityType, entityId, user);
    return entity.then((resolved) => resolved.policy);
  }

  @Patch('entities/:entityType/:entityId/policy')
  updatePolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.policyService.updatePolicy(
      this.parseEntityType(entityType),
      entityId,
      user,
      body,
      profile,
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
