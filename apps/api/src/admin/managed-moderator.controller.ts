import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedModeratorService } from './managed-moderator.service';

@Controller('v1/managed-entities/:entityType/:entityId/moderator')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation')
export class ManagedModeratorController {
  constructor(private readonly moderators: ManagedModeratorService) {}

  @Get()
  choices(
    @CurrentUser() user: AuthUser,
    @Param('entityType') type: string,
    @Param('entityId') id: string,
  ) {
    return this.moderators.choices(user, type, id);
  }

  @Post()
  assign(
    @CurrentUser() user: AuthUser,
    @Param('entityType') type: string,
    @Param('entityId') id: string,
    @Body() body: unknown,
  ) {
    return this.moderators.assign(user, type, id, body);
  }

  @Get('operations/:operationId')
  operation(
    @CurrentUser() user: AuthUser,
    @Param('entityType') type: string,
    @Param('entityId') id: string,
    @Param('operationId') operationId: string,
  ) {
    return this.moderators.operation(user, type, id, operationId);
  }
}
