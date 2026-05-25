import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { VkParsingService } from './vk-parsing.service';

@Injectable()
export class VkParsingRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VkParsingRunnerService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly vkParsingService: VkParsingService) {}

  onModuleInit(): void {
    const intervalMs = this.vkParsingService.getSyncIntervalMs();
    this.timer = setInterval(() => void this.run('scheduled'), intervalMs);
    this.timer.unref?.();
    setTimeout(() => void this.run('startup'), Math.min(30_000, intervalMs)).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      await this.vkParsingService.syncDueSources();
    } catch (error) {
      this.logger.warn({ err: error, reason }, 'VK parsing runner failed');
    } finally {
      this.inFlight = false;
    }
  }
}
