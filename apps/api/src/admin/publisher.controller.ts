import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts/publisher';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublisherPolicyService } from './publisher-policy.service';

@Controller('v1/publisher')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation', 'publisher')
export class PublisherController {
  constructor(private readonly policyService: PublisherPolicyService) {}

  @Get('entities')
  listEntities(@CurrentUser() user: AuthUser) {
    return this.policyService.listEntities(user);
  }

  @Get('entities/:entityType/:entityId')
  getEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.policyService.getEntity(this.parseEntityType(entityType), entityId, user);
  }

  @Get('entities/:entityType/:entityId/policy')
  getPolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.policyService
      .getEntity(this.parseEntityType(entityType), entityId, user)
      .then((entity) => entity.policy);
  }

  @Patch('entities/:entityType/:entityId/policy')
  @MiniappProfiles('moderation')
  updatePolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.policyService.updatePolicy(this.parseEntityType(entityType), entityId, user, body);
  }

  private parseEntityType(value: string): ManagedEntityType {
    if (value === 'chat' || value === 'channel') {
      return value;
    }
    throw new BadRequestException('Unsupported managed entity type');
  }
}
