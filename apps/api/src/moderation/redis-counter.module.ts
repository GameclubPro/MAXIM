import { Global, Module } from '@nestjs/common';
import { RedisCounterService } from './redis-counter.service';

@Global()
@Module({
  providers: [RedisCounterService],
  exports: [RedisCounterService],
})
export class RedisCounterModule {}
