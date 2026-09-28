import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherStartQueueService } from './publisher-start.queue';

@Injectable()
export class PublisherStartRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherStartRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherStartQueueService,
    private readonly registry: MaxBotRegistryService,
    private readonly runtime: PublisherRuntimeBoundaryService,
    private readonly background: PublisherBackgroundWorkCoordinatorService,
  ) {}

  onModuleInit(): void {
    if (!this.runtime.dispatchEnabled) return;
    this.timer = setInterval(() => {
      if (this.pending || this.stopping) return;
      this.pending = this.recoverOnce()
        .catch(() => this.logger.warn('Publisher greeting recovery failed'))
        .finally(() => {
          this.pending = null;
        });
    }, 30_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }

  async recoverOnce(now = new Date()): Promise<void> {
    if (this.stopping || !this.runtime.dispatchEnabled) return;
    await this.background.runExclusive('start_recovery', async () => {
      const intents = await this.prisma.publisherStartIntent.findMany({
        where: { status: 'PENDING', nextEnqueueAt: { lte: now } },
        orderBy: [{ nextEnqueueAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      const deadline = Date.now() + 10_000;
      for (const intent of intents) {
        if (this.stopping || !this.runtime.dispatchEnabled || Date.now() >= deadline) break;
        if (
          intent.expiresAt <= now ||
          intent.publisherBotId !== this.registry.getPublisherBotDescriptor().id
        ) {
          await this.prisma.publisherStartIntent.updateMany({
            where: { id: intent.id, status: 'PENDING' },
            data: { status: 'EXPIRED' },
          });
          continue;
        }
        // FLAG: Only newly persisted PENDING intents are producers. ATTEMPTED/UNKNOWN,
        // historical webhook receipts and legacy jobs can never originate another send.
        try {
          await this.queue.enqueueIntent(intent);
        } catch {
          await this.prisma.publisherStartIntent.updateMany({
            where: { id: intent.id, status: 'PENDING' },
            data: { nextEnqueueAt: new Date(Date.now() + 60_000) },
          });
          this.logger.warn('Publisher greeting enqueue deferred');
        }
      }
    });
  }
}
