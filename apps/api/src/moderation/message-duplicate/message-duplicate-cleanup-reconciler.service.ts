import {
  MessageDuplicateMetricsService,
  recordDuplicatePhase,
} from './message-duplicate-metrics.service';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';

@Injectable()
export class MessageDuplicateCleanupReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageDuplicateCleanupReconcilerService.name);
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  private hadDueSample = false;

  constructor(
    private readonly intents: ModerationDeleteIntentService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
  ) {}

  onModuleInit(): void {
    // FLAG: Registered only in the action role; independent of Redis/BullMQ and
    // feature switches. Cleanup never restores analysis or executes MAX actions.
    this.timer = setInterval(() => void this.reconcile(), 10_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcile(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const startedAt = performance.now();
    let activeOrFailed = false;
    try {
      await this.intents.reconcileExpiredMessageDuplicateActions((sample) => {
        activeOrFailed = sample.sampledDue > 0;
        const shouldLog = sample.sampledDue > 0 || this.hadDueSample;
        this.hadDueSample = sample.sampledDue > 0;
        if (shouldLog)
          this.logger.log({
            event: 'message_duplicate_cleanup_sample',
            schemaVersion: 1,
            ...sample,
          });
      });
    } catch {
      activeOrFailed = true;
      this.logger.warn('Duplicate unused claim reconciliation unavailable');
    } finally {
      if (activeOrFailed)
        recordDuplicatePhase(this.metrics, 'cleanup_sweep', performance.now() - startedAt);
      this.inFlight = false;
    }
  }
}
