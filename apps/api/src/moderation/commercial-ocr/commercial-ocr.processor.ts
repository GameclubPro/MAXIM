import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';
import { CommercialOcrModerationService } from './commercial-ocr-moderation.service';
import { CommercialOcrMetricsService } from './commercial-ocr-metrics.service';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_DEFAULT_VERSION,
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
  COMMERCIAL_OCR_QUEUE,
  validateCommercialOcrImageCount,
  validateCommercialOcrVersion,
  type CommercialOcrJob,
} from './commercial-ocr.queue';

const MAX_DEFER_MS = 10 * 60_000;
const DEFAULT_MAX_JOB_AGE_MS = 5 * 60_000;
const DEFER_REASONS = new Set([
  'source_not_ready',
  'governor_pressure',
  'admission_pending',
] as const);
const RETRY_REASONS = new Set(['download_failed', 'ocr_failed'] as const);

type CommercialOcrJobIdentity = {
  jobId: string;
  chatId: string;
};

type CommercialOcrDeferResult = {
  kind: 'defer';
  delayMs: number;
  reason: 'source_not_ready' | 'governor_pressure' | 'admission_pending';
};

type CommercialOcrRetryResult = {
  kind: 'retry';
  reason: 'download_failed' | 'ocr_failed';
};

@Processor(COMMERCIAL_OCR_QUEUE, {
  concurrency: 1,
})
export class CommercialOcrProcessor extends WorkerHost {
  private readonly logger = new Logger(CommercialOcrProcessor.name);
  private readonly maxJobAgeMs: number;

  constructor(
    private readonly moderationService: CommercialOcrModerationService,
    private readonly admissionStore: CommercialOcrAdmissionStore,
    private readonly configService: ConfigService,
    private readonly metrics: CommercialOcrMetricsService,
  ) {
    super();
    this.maxJobAgeMs = readPositiveInteger(
      configService.get('COMMERCIAL_OCR_MAX_JOB_AGE_MS'),
      DEFAULT_MAX_JOB_AGE_MS,
    );
  }

  async process(job: Job<CommercialOcrJob>, token?: string): Promise<void> {
    let identity: CommercialOcrJobIdentity;
    let result: Awaited<ReturnType<CommercialOcrModerationService['processCommercialOcrJob']>>;

    try {
      identity = this.validateJobIdentity(job);
    } catch (error: unknown) {
      throw asUnrecoverableError(error, 'Commercial OCR job identity is invalid');
    }

    try {
      this.validateJobEnvelope(job);
    } catch (error: unknown) {
      await this.releaseAdmission(identity);
      throw asUnrecoverableError(error, 'Commercial OCR job envelope is invalid');
    }

    if ((job.attemptsStarted ?? 1) <= 1) {
      const processingStartedAtMs = job.processedOn ?? Date.now();
      this.metrics.recordQueueWait(Math.max(0, processingStartedAtMs - job.timestamp));
    }

    const deadlineAtMs = Date.parse(job.data.sourceCreatedAt) + this.maxJobAgeMs;
    if (deadlineAtMs <= Date.now()) {
      await this.releaseAdmission(identity);
      return;
    }

    try {
      result = await this.moderationService.processCommercialOcrJob(
        job.data,
        identity.jobId,
        deadlineAtMs,
      );
    } catch (error: unknown) {
      if (error instanceof UnrecoverableError) {
        await this.releaseAdmission(identity);
      } else {
        await this.releaseIfFinalAttempt(job, identity);
      }
      throw error;
    }
    if (!isCommercialOcrProcessResult(result)) {
      await this.releaseAdmission(identity);
      throw new UnrecoverableError('Commercial OCR moderation returned an invalid result');
    }

    if (result.kind === 'completed') {
      await this.releaseAdmission(identity);
      return;
    }
    if (deadlineAtMs <= Date.now()) {
      await this.releaseAdmission(identity);
      return;
    }
    if (result.kind === 'retry') {
      await this.releaseIfFinalAttempt(job, identity);
      throw new Error(`Commercial OCR transient failure: ${result.reason}`);
    }

    await this.deferWithoutConsumingAttempt(job, token, identity, result, deadlineAtMs);
  }

  private validateJobIdentity(job: Job<CommercialOcrJob>): CommercialOcrJobIdentity {
    const data = job.data;
    if (data.schemaVersion !== COMMERCIAL_OCR_JOB_SCHEMA_VERSION) {
      throw new Error('Commercial OCR job schema version is invalid');
    }
    const expectedJobId = buildCommercialOcrJobId({
      chatId: data.chatId,
      messageId: data.messageId,
      sourceCreatedAt: data.sourceCreatedAt,
      ocrVersion: data.ocrVersion,
      schemaVersion: data.schemaVersion,
    });
    if (job.id !== expectedJobId || data.idempotencyKey !== expectedJobId) {
      throw new Error('Commercial OCR job identity is invalid');
    }
    return { jobId: expectedJobId, chatId: data.chatId };
  }

  private validateJobEnvelope(job: Job<CommercialOcrJob>): void {
    const data = job.data;
    if (job.name !== COMMERCIAL_OCR_JOB_NAME) {
      throw new Error('Commercial OCR job name is invalid');
    }
    validateCommercialOcrImageCount(data.imageCount);
    const jobOcrVersion = validateCommercialOcrVersion(data.ocrVersion);
    if (jobOcrVersion !== COMMERCIAL_OCR_DEFAULT_VERSION) {
      throw new Error('Commercial OCR job version is stale');
    }
    if (
      typeof data.webhookEventId !== 'string' ||
      !data.webhookEventId.trim() ||
      data.webhookEventId.length > 512 ||
      typeof data.actionEligible !== 'boolean' ||
      data.sourceTag !== 'commercial-image-ocr' ||
      !isValidTimestamp(data.createdAt)
    ) {
      throw new Error('Commercial OCR job envelope is invalid');
    }
  }

  private async deferWithoutConsumingAttempt(
    job: Job<CommercialOcrJob>,
    token: string | undefined,
    identity: CommercialOcrJobIdentity,
    result: CommercialOcrDeferResult,
    deadlineAtMs: number,
  ): Promise<never> {
    if (!token) {
      await this.releaseIfFinalAttempt(job, identity);
      throw new Error(`Commercial OCR job deferred without a lock token: ${result.reason}`);
    }
    const deferUntilMs = Date.now() + result.delayMs;
    if (deferUntilMs >= deadlineAtMs) {
      await this.releaseAdmission(identity);
      throw new UnrecoverableError(`Commercial OCR job deadline exhausted: ${result.reason}`);
    }
    try {
      await job.moveToDelayed(deferUntilMs, token);
    } catch (error: unknown) {
      await this.releaseIfFinalAttempt(job, identity);
      throw new Error(`Commercial OCR job defer failed: ${result.reason}`, { cause: error });
    }
    throw new DelayedError();
  }

  private async releaseIfFinalAttempt(
    job: Job<CommercialOcrJob>,
    identity: CommercialOcrJobIdentity,
  ): Promise<void> {
    const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    if (job.attemptsMade + 1 >= attempts) {
      await this.releaseAdmission(identity);
    }
  }

  private async releaseAdmission(identity: CommercialOcrJobIdentity): Promise<void> {
    const released = await this.admissionStore.release(identity).catch(() => false);
    if (!released) {
      this.logger.warn(
        { jobId: identity.jobId },
        'Commercial OCR admission release failed; expiry cleanup remains authoritative',
      );
    }
  }
}

function isCommercialOcrProcessResult(
  value: unknown,
): value is { kind: 'completed' } | CommercialOcrRetryResult | CommercialOcrDeferResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (result.kind === 'completed') {
    return true;
  }
  if (
    result.kind === 'retry' &&
    RETRY_REASONS.has(result.reason as CommercialOcrRetryResult['reason'])
  ) {
    return true;
  }
  return (
    result.kind === 'defer' &&
    Number.isSafeInteger(result.delayMs) &&
    (result.delayMs as number) >= 1 &&
    (result.delayMs as number) <= MAX_DEFER_MS &&
    DEFER_REASONS.has(result.reason as CommercialOcrDeferResult['reason'])
  );
}

function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asUnrecoverableError(error: unknown, fallbackMessage: string): UnrecoverableError {
  if (error instanceof UnrecoverableError) {
    return error;
  }
  return new UnrecoverableError(error instanceof Error ? error.message : fallbackMessage);
}
