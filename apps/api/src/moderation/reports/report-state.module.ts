import { Module } from '@nestjs/common';
import { MaxModule } from '../../max/max.module';
import { ReportStateService } from './report-state.service';
import { ModerationSanctionStateFenceService } from '../moderation-sanction-state-fence.service';
import { ReportTelemetryService } from './report-telemetry.service';

@Module({
  imports: [MaxModule],
  providers: [ReportStateService, ModerationSanctionStateFenceService, ReportTelemetryService],
  exports: [ReportStateService, ReportTelemetryService],
})
export class ReportStateModule {}
