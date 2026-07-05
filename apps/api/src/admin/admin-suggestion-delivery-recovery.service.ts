import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  CHANNEL_SUGGESTION_DELIVERY_RECOVERY_INTERVAL_MS,
  CHANNEL_SUGGESTION_DELIVERY_RECOVERY_STARTUP_DELAY_MS,
} from './admin.service.support';
import { ChannelDialogService } from './channel-dialog.service';

@Injectable()
export class AdminSuggestionDeliveryRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminSuggestionDeliveryRecoveryService.name);
  private readonly enabled = roleRunsAction(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly channelDialogService: ChannelDialogService) {}

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.run('startup');
    }, CHANNEL_SUGGESTION_DELIVERY_RECOVERY_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();

    this.timer = setInterval(() => {
      void this.run('scheduled');
    }, CHANNEL_SUGGESTION_DELIVERY_RECOVERY_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.enabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const recovered = await this.channelDialogService.recoverStaleChannelSuggestionDeliveries();
      if (recovered > 0) {
        this.logger.warn(
          {
            reason,
            recovered,
          },
          'Recovered stale channel suggestion delivery jobs',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover stale channel suggestion delivery jobs',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
