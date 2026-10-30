import { Module } from '@nestjs/common';
import { StatsAccessService } from './stats-access.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsReadService } from './stats-read.service';
import { StatsChangesService } from './stats-changes.service';
import { StatsController, StatsGuard } from './stats.controller';
import { MaximNativeStatsAdapter } from './maxim-native-stats.adapter';
import { StatsAnalyticsService } from './stats-analytics.service';
@Module({
  controllers: [StatsController],
  providers: [
    StatsAccessService,
    StatsIngestService,
    StatsReadService,
    StatsChangesService,
    StatsGuard,
    MaximNativeStatsAdapter,
    StatsAnalyticsService,
  ],
  exports: [StatsAccessService, StatsReadService],
})
export class StatsModule {}
