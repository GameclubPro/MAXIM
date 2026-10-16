import {
  safetyDeskPublicationCohortResponseSchema,
  type SafetyDeskPublicationCohortResponse,
} from '@maxim/contracts/safety-desk';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildSafetyDeskPublicationCohortIndexQuery,
  buildSafetyDeskPublicationCohortQuery,
} from './safety-desk-publication-cohort.query';

const CACHE_TTL_MS = 10_000;

@Injectable()
export class SafetyDeskPublicationCohortService {
  private cached: { snapshot: SafetyDeskPublicationCohortResponse; at: number } | null = null;
  private inFlight: Promise<SafetyDeskPublicationCohortResponse> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  getSnapshot(): Promise<SafetyDeskPublicationCohortResponse> {
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

  private async loadSnapshot(): Promise<SafetyDeskPublicationCohortResponse> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          const indexes = await tx.$queryRaw<Array<{ ready: boolean }>>(
            buildSafetyDeskPublicationCohortIndexQuery(),
          );
          if (indexes[0]?.ready !== true) {
            throw new Error('Required occurrence cohort indexes are unavailable');
          }
          const rows = await tx.$queryRaw<Array<{ snapshot: unknown }>>(
            buildSafetyDeskPublicationCohortQuery(),
          );
          return safetyDeskPublicationCohortResponseSchema.parse(rows[0]?.snapshot);
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
    } catch {
      // FLAG: Failed refreshes never replace missing evidence with stale success or raw SQL errors.
      throw new ServiceUnavailableException('Сводка публикаций временно недоступна.');
    }
  }
}
