import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { NetworkSettingsService } from './network-settings.service';
import { MajorNetworksGuard } from './major-networks.guard';

@Controller('v1/networks/settings')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation')
export class NetworkSettingsController {
  constructor(private readonly settings: NetworkSettingsService) {}
  @Post('read')
  @UseGuards(MajorNetworksGuard)
  read(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.settings.read(user, body);
  }
  @Post('preview')
  @UseGuards(MajorNetworksGuard)
  preview(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.settings.preview(user, body);
  }
  @Post('apply')
  @UseGuards(MajorNetworksGuard)
  apply(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.settings.apply(user, body);
  }
  @Get('operations/:operationId') status(
    @CurrentUser() user: AuthUser,
    @Param('operationId') operationId: string,
  ) {
    return this.settings.status(user, operationId);
  }
}
