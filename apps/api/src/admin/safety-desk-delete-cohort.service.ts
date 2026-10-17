import { type SafetyDeskDeleteCohortResponse } from '@maxim/contracts/safety-desk';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  projectSafetyDeskDeleteCohort,
  type SafetyDeskDeleteCohortQueryRow,
} from './safety-desk-delete-cohort.model';
import {
  buildSafetyDeskDeleteCohortIndexQuery,
  buildSafetyDeskDeleteCohortQuery,
} from './safety-desk-delete-cohort.query';

const CACHE_TTL_MS = 10_000;

@Injectable()
export class SafetyDeskDeleteCohortService {
  private cached: { snapshot: SafetyDeskDeleteCohortResponse; at: number } | null = null;
  private inFlight: Promise<SafetyDeskDeleteCohortResponse> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  getSnapshot(): Promise<SafetyDeskDeleteCohortResponse> {
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

  private async loadSnapshot(): Promise<SafetyDeskDeleteCohortResponse> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          const indexes = await tx.$queryRaw<Array<{ ready: boolean }>>(
            buildSafetyDeskDeleteCohortIndexQuery(),
          );
          if (indexes[0]?.ready !== true)
            throw new Error('Required deletion cohort indexes are unavailable');
          const records = await tx.$queryRaw<SafetyDeskDeleteCohortQueryRow[]>(
            buildSafetyDeskDeleteCohortQuery(),
          );
          return projectSafetyDeskDeleteCohort(records);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 2_000,
          timeout: 5_000,
        },
      );
    } catch {
      // FLAG: A missing or failed observation never becomes a stale success or a fallback scan.
      throw new ServiceUnavailableException('Сводка удалений временно недоступна.');
    }
  }
}
