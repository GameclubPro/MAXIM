import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { WebhookStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { MaxUpdate } from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('moderation') private readonly queue: Queue,
  ) {}

  async ingest(update: MaxUpdate, sourceIp: string | null) {
    try {
      const event = await this.prisma.webhookEvent.create({
        data: {
          dedupKey: update.updateId,
          sourceIp: sourceIp ?? undefined,
          rawPayload: update.raw ?? {},
          normalizedPayload: update,
        },
      });

      await this.queue.add(
        'process-webhook-event',
        { webhookEventId: event.id },
        {
          attempts: 5,
          removeOnComplete: true,
          removeOnFail: false,
          backoff: {
            type: 'exponential',
            delay: 1_000,
          },
        },
      );

      return { accepted: true, duplicate: false };
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        await this.prisma.webhookEvent.updateMany({
          where: {
            dedupKey: update.updateId,
          },
          data: {
            status: WebhookStatus.DUPLICATE,
          },
        });

        return { accepted: true, duplicate: true };
      }

      this.logger.error({ err: error }, 'Failed to ingest webhook event');
      throw error;
    }
  }
}
