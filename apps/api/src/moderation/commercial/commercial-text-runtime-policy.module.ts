import { Module } from '@nestjs/common';
import { RedisCounterModule } from '../redis-counter.module';
import { CommercialTextRuntimePolicyService } from './commercial-text-runtime-policy.service';

@Module({
  imports: [RedisCounterModule],
  providers: [CommercialTextRuntimePolicyService],
  exports: [CommercialTextRuntimePolicyService],
})
export class CommercialTextRuntimePolicyModule {}
