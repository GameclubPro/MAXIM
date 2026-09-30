import { Global, Module } from '@nestjs/common';
import { StorageRuntimeMetricsService } from './storage-runtime-metrics.service';

@Global()
@Module({
  providers: [StorageRuntimeMetricsService],
  exports: [StorageRuntimeMetricsService],
})
export class StorageRuntimeMetricsModule {}
