import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NIGHT_MODE_TRANSITION_QUEUE } from './night-mode-transition.queue';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';

@Module({
  imports: [BullModule.registerQueue({ name: NIGHT_MODE_TRANSITION_QUEUE })],
  providers: [NightModeTransitionSchedulerService],
  exports: [BullModule, NightModeTransitionSchedulerService],
})
export class NightModeTransitionModule {}
