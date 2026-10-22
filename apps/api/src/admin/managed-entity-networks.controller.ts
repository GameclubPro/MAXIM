import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';

@Controller('v1/managed-entities/networks')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation')
export class ManagedEntityNetworksController {
  constructor(private readonly networks: ManagedEntityNetworksService) {}

  @Get(':entityType')
  catalogue(@CurrentUser() user: AuthUser, @Param('entityType') type: string) {
    return this.networks.catalogue(user, type);
  }

  @Get(':entityType/entities')
  entries(
    @CurrentUser() user: AuthUser,
    @Param('entityType') type: string,
    @Query() query: unknown,
  ) {
    return this.networks.entries(user, type, query);
  }

  @Put(':entityType/composition')
  updateComposition(
    @CurrentUser() user: AuthUser,
    @Param('entityType') type: string,
    @Body() body: unknown,
  ) {
    return this.networks.updateComposition(user, type, body);
  }
}
