import { Module } from '@nestjs/common';
import { MaxModule } from '../../max/max.module';
import { ReportStateService } from './report-state.service';

@Module({ imports: [MaxModule], providers: [ReportStateService], exports: [ReportStateService] })
export class ReportStateModule {}
