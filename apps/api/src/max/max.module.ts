import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { MaxActionProcessor } from './max-action.processor';
import { MaxClientService } from './max-client.service';

const maxProviders = [MaxClientService, ...(roleRunsAction(getAppRole()) ? [MaxActionProcessor] : [])];

@Module({
  imports: [
    HttpModule.register({
      timeout: 5_000,
      maxRedirects: 0,
    }),
    SystemModule,
    BullModule.registerQueue({ name: 'moderation-actions' }),
  ],
  providers: maxProviders,
  exports: [MaxClientService],
})
export class MaxModule {}
