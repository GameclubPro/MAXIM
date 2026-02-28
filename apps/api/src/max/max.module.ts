import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MaxClientService } from './max-client.service';

@Module({
  imports: [HttpModule],
  providers: [MaxClientService],
  exports: [MaxClientService],
})
export class MaxModule {}
