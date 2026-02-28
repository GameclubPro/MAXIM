import { Module } from '@nestjs/common';
import { MaxClientService } from './max-client.service';

@Module({
  providers: [MaxClientService],
  exports: [MaxClientService],
})
export class MaxModule {}
