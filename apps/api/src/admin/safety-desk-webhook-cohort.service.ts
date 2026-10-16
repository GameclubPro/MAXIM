import {
  safetyDeskWebhookCohortResponseSchema,
  type SafetyDeskWebhookCohortResponse,
} from '@maxim/contracts/safety-desk';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildSafetyDeskWebhookCohortIndexQuery,
  buildSafetyDeskWebhookCohortQuery,
} from './safety-desk-webhook-cohort.query';

const CACHE_TTL_MS = 10_000;

@Injectable()
export class SafetyDeskWebhookCohortService {
  private cached: { snapshot: SafetyDeskWebhookCohortResponse; at: number } | null = null;
  private inFlight: Promise<SafetyDeskWebhookCohortResponse> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  getSnapshot(): Promise<SafetyDeskWebhookCohortResponse> {
    if (this.cached) {
      const ageMs = Date.now() - this.cached.at;
      if (ageMs >= 0 && ageMs < CACHE_TTL_MS) return Promise.resolve(this.cached.snapshot);
    }
    if (this.inFlight) return this.inFlight;

    const request = this.loadSnapshot().then((snapshot) => {
      this.cached = { snapshot, at: Date.now() };
      return snapshot;
    });
    this.inFlight = request;
    const clear = () => {
      if (this.inFlight === request) this.inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  private async loadSnapshot(): Promise<SafetyDeskWebhookCohortResponse> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          const indexes = await tx.$queryRaw<Array<{ ready: boolean }>>(
            buildSafetyDeskWebhookCohortIndexQuery(),
          );
          if (indexes[0]?.ready !== true) {
            throw new Error('Required receipt cohort index is unavailable');
          }
          const rows = await tx.$queryRaw<Array<{ snapshot: unknown }>>(
            buildSafetyDeskWebhookCohortQuery(),
          );
          return safetyDeskWebhookCohortResponseSchema.parse(rows[0]?.snapshot);
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
    } catch {
      // FLAG: Failed refreshes must not turn expired cached evidence into a healthy sample.
      // Diagnostic SQL and connection errors may contain credentials; return fixed copy only.
      throw new ServiceUnavailableException('Сводка обработки временно недоступна.');
    }
  }
}
