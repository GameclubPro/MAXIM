import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { NetworkStatisticsService } from './network-statistics.service';
import { MajorNetworksGuard } from './major-networks.guard';

@Controller('v1/managed-entities/networks')
@UseGuards(InitDataGuard, MajorNetworksGuard)
@MiniappProfiles('moderation')
export class NetworkStatisticsController {
  constructor(private readonly statistics: NetworkStatisticsService) {}

  @Get(':entityType/stats')
  read(
    @CurrentUser() user: AuthUser,
    @Param('entityType') entityType: string,
    @Query() query: unknown,
  ) {
    return this.statistics.read(user, entityType, query);
  }
}
