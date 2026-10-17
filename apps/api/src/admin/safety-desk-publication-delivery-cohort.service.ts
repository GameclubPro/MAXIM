import {
  safetyDeskPublicationDeliveryCohortResponseSchema,
  safetyDeskPublicationDeliveryStatusSchema,
  safetyDeskPublicationDeliveryWaitReasonSchema,
  type SafetyDeskPublicationDeliveryCohortResponse,
} from '@maxim/contracts/safety-desk';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublicationDeliveryIndexesQuery } from './safety-desk-publication-delivery-evidence.query';
import { buildPublicationDeliveryCohortQuery } from './safety-desk-publication-delivery-cohort.query';
import {
  projectPublicationSavedDelivery,
  type PublicationDeliveryEvidenceRow,
} from './safety-desk-publication-delivery-evidence.model';
export type PublicationDeliveryCohortRow = PublicationDeliveryEvidenceRow & {
  headStatus: PublicationDeliveryEvidenceRow['status'];
  captured: number;
  windowStartedAt: Date;
  windowEndedAt: Date;
};
export function projectPublicationDeliveryCohort(
  rows: readonly PublicationDeliveryCohortRow[],
): SafetyDeskPublicationDeliveryCohortResponse {
  if (!rows[0]) throw new Error('Missing snapshot bounds');
  if (new Set(rows.map((row) => row.headStatus)).size !== 6)
    throw new Error('Incomplete stored status heads');
  const zeroWait = () =>
    Object.fromEntries(
      safetyDeskPublicationDeliveryWaitReasonSchema.options.map((reason) => [reason, 0]),
    ) as Record<(typeof safetyDeskPublicationDeliveryWaitReasonSchema.options)[number], number>;
  const grouped: SafetyDeskPublicationDeliveryCohortResponse['rows'] =
    safetyDeskPublicationDeliveryStatusSchema.options.map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      effectiveStatusCounts: {
        PENDING: 0,
        SENDING: 0,
        SENT: 0,
        FAILED: 0,
        AMBIGUOUS: 0,
        CANCELED: 0,
      },
      receiptEvidenceCounts: { saved: 0, missing: 0, legacy_unproven: 0, invalid_evidence: 0 },
      verificationCounts: {
        automated_stable: 0,
        operator_confirmed: 0,
        legacy_unproven: 0,
        pending: 0,
        not_recorded: 0,
        invalid_evidence: 0,
      },
      deadlineCounts: { future: 0, due: 0, expired: 0, unknown: 0 },
      waitingReasonCounts: zeroWait(),
      waitingReasonCountsOverlap: true,
    }));
  const examples: SafetyDeskPublicationDeliveryCohortResponse['examples'] = [];
  for (const row of rows) {
    const group = grouped.find((group) => group.status === row.headStatus);
    if (!group) throw new Error('Unknown stored status');
    if (
      !Number.isSafeInteger(row.captured) ||
      row.captured < 0 ||
      row.captured > 513 ||
      row.observedAt.getTime() !== rows[0].observedAt.getTime() ||
      row.windowStartedAt.getTime() !== rows[0].windowStartedAt.getTime() ||
      row.windowEndedAt.getTime() !== rows[0].windowEndedAt.getTime()
    )
      throw new Error('Invalid bounded snapshot');
    group.truncated = row.captured > 512;
    if (!row.id) continue;
    const saved = projectPublicationSavedDelivery(row);
    group.countLowerBound++;
    group.effectiveStatusCounts[row.effectiveStatus]++;
    group.receiptEvidenceCounts[saved.recipient.state]++;
    group.verificationCounts[saved.verification.state]++;
    group.deadlineCounts[saved.waiting.deadline]++;
    for (const reason of saved.waiting.reasons) group.waitingReasonCounts[reason]++;
    if (examples.length < 8)
      examples.push({
        deliveryId: row.id,
        acceptedAt: row.createdAt.toISOString(),
        storedStatus: row.status,
        effectiveStatus: row.effectiveStatus,
        receipt: saved.recipient.state,
      });
  }
  for (const group of grouped) {
    if (
      group.countLowerBound !==
      Math.min(rows.find((row) => row.headStatus === group.status)!.captured, 512)
    )
      throw new Error('Missing scalar recipient evidence');
  }
  return safetyDeskPublicationDeliveryCohortResponseSchema.parse({
    schemaVersion: 1,
    basis: 'recipient_created_at',
    dispatchProfile: 'PUBLIK_V1',
    retryMembership: 'same_delivery',
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: rows[0].windowStartedAt.toISOString(),
    windowEndedAt: rows[0].windowEndedAt.toISOString(),
    observedAt: rows[0].observedAt.toISOString(),
    sampleLimitPerStatus: 512,
    sampleComplete: grouped.every((row) => !row.truncated),
    totalCountLowerBound: grouped.reduce((sum, row) => sum + row.countLowerBound, 0),
    completionTimingEvidence: 'not_recorded',
    ledgerEvidence: 'not_joined',
    rows: grouped,
    examples,
  });
}
@Injectable()
export class SafetyDeskPublicationDeliveryCohortService {
  private cached: { snapshot: SafetyDeskPublicationDeliveryCohortResponse; at: number } | null =
    null;
  private inFlight: Promise<SafetyDeskPublicationDeliveryCohortResponse> | null = null;
  constructor(private readonly prisma: PrismaService) {}
  getSnapshot(): Promise<SafetyDeskPublicationDeliveryCohortResponse> {
    const age = this.cached ? Date.now() - this.cached.at : -1;
    if (this.cached && age >= 0 && age < 10000) return Promise.resolve(this.cached.snapshot);
    if (this.inFlight) return this.inFlight;
    const request = this.load().then((snapshot) => {
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
  private async load(): Promise<SafetyDeskPublicationDeliveryCohortResponse> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          const indexes = await tx.$queryRaw<Array<{ ready: boolean }>>(
            buildPublicationDeliveryIndexesQuery(true),
          );
          if (indexes[0]?.ready !== true)
            throw new Error('Required delivery cohort indexes unavailable');
          return projectPublicationDeliveryCohort(
            await tx.$queryRaw<PublicationDeliveryCohortRow[]>(
              buildPublicationDeliveryCohortQuery(),
            ),
          );
        },
        { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 },
      );
    } catch {
      throw new ServiceUnavailableException('Сводка доставок временно недоступна.');
    }
  }
}
