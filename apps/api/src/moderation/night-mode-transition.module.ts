import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NIGHT_MODE_TRANSITION_QUEUE } from './night-mode-transition.queue';
import { NightModeTransitionReconcileService } from './night-mode-transition-reconcile.service';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import { RedisCounterModule } from './redis-counter.module';

@Module({
  imports: [RedisCounterModule, BullModule.registerQueue({ name: NIGHT_MODE_TRANSITION_QUEUE })],
  providers: [NightModeTransitionSchedulerService, NightModeTransitionReconcileService],
  exports: [BullModule, NightModeTransitionSchedulerService],
})
export class NightModeTransitionModule {}
