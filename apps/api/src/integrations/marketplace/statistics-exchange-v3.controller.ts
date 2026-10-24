import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { MarketplaceIntegrationGuard } from './marketplace-integration.guard';
import { StatisticsExchangeV3MembershipService } from './statistics-exchange-v3-membership.service';
import { StatisticsExchangeV3Service } from './statistics-exchange-v3.service';

@Controller('v1/integrations/svyazka/v3')
@UseGuards(MarketplaceIntegrationGuard)
export class StatisticsExchangeV3Controller {
  constructor(
    private readonly membership: StatisticsExchangeV3MembershipService,
    private readonly statistics: StatisticsExchangeV3Service,
  ) {}
  @Get('capabilities') capabilities() {
    return this.membership.capabilities();
  }
  @Post('membership-snapshots') snapshot(@Body() body: unknown) {
    return this.membership.snapshot(body);
  }
  @Get('membership-snapshots/:id') snapshotStatus(@Param('id') id: string) {
    return this.membership.snapshotStatus(id);
  }
  @Get('membership-snapshots/:id/pages/:pageIndex') snapshotPage(
    @Param('id') id: string,
    @Param('pageIndex') pageIndex: string,
  ) {
    return this.membership.snapshotPage(id, pageIndex);
  }
  @Put('grants/:id') put(@Param('id') id: string, @Body() body: unknown) {
    return this.membership.put(id, body);
  }
  @Get('grants/:id') grant(@Param('id') id: string) {
    return this.membership.read(id);
  }
  @Get('grants/:id/access') access(@Param('id') id: string, @Query() query: unknown) {
    return this.membership.access(id, query);
  }
  @Get('grants/:id/entities/:kind/:entityId/metadata') metadata(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('entityId') entityId: string,
    @Query() query: unknown,
  ) {
    return this.membership.metadata(id, kind, entityId, query);
  }
  @Get('grants/:id/statistics/head') head(@Param('id') id: string, @Query() query: unknown) {
    this.membership.assertEnabled();
    return this.statistics.head(id, query);
  }
  @Get('grants/:id/statistics/generations/:generationId/pages/:pageIndex') page(
    @Param('id') id: string,
    @Param('generationId') generationId: string,
    @Param('pageIndex') pageIndex: string,
    @Query() query: unknown,
  ) {
    this.membership.assertEnabled();
    return this.statistics.page(id, generationId, Number(pageIndex), query);
  }
}
