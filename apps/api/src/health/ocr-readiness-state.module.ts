import { Module } from '@nestjs/common';
import { OcrReadinessStateService } from './ocr-readiness-state.service';

@Module({
  providers: [OcrReadinessStateService],
  exports: [OcrReadinessStateService],
})
export class OcrReadinessStateModule {}
