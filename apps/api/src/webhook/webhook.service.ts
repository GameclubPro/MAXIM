import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookStatus } from '@prisma/client';
import type { MaxUpdate } from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly rawPayloadSampleRate: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.rawPayloadSampleRate = configService.get<number>('RAW_PAYLOAD_SAMPLE_RATE', 0.01);
  }

  async ingest(update: MaxUpdate, sourceIp: string | null) {
    try {
      const shouldKeepRawPayload = Math.random() <= this.rawPayloadSampleRate;
      await this.prisma.webhookEvent.create({
        data: {
          dedupKey: update.updateId,
          sourceIp: sourceIp ?? undefined,
          rawPayload: shouldKeepRawPayload ? (update.raw ?? {}) : {},
          normalizedPayload: update,
          status: WebhookStatus.RECEIVED,
        },
      });

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
