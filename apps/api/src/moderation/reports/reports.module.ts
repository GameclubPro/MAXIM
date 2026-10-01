import { Module } from '@nestjs/common';
import { MaxModule } from '../../max/max.module';
import { RedisCounterModule } from '../redis-counter.module';
import { ModerationDeleteIntentModule } from '../moderation-delete-intent.module';
import { ReportStateModule } from './report-state.module';
import { ReportSubmissionService } from './report-submission.service';
import { ReportExecutionService } from './report-execution.service';
import { ReportViewService } from './report-view.service';
import { ReportRetentionService } from './report-retention.service';

@Module({
  imports: [MaxModule, RedisCounterModule, ModerationDeleteIntentModule, ReportStateModule],
  providers: [
    ReportSubmissionService,
    ReportExecutionService,
    ReportViewService,
    ReportRetentionService,
  ],
  exports: [ReportSubmissionService, ReportViewService],
})
export class ReportsModule {}
