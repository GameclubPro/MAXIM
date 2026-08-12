import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

import { raceWithTimeout } from '../../common/promise-timeout.util';
import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_DEFAULT_VERSION,
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_JOB_OPTIONS,
  COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
  COMMERCIAL_OCR_QUEUE,
  normalizeCommercialOcrActionEligibility,
  validateCommercialOcrImageCount,
  validateCommercialOcrVersion,
  type CommercialOcrJob,
} from './commercial-ocr.queue';
import { resolveCommercialOcrRuntimePolicy } from './commercial-ocr.runtime';

const DEFAULT_MAX_GLOBAL_IMAGE_UNITS = 16;
const DEFAULT_MAX_CHAT_IMAGE_UNITS = 10;
const DEFAULT_MAX_JOB_AGE_MS = 5 * 60_000;
const DEFAULT_RESERVATION_TTL_MS = 10 * 60_000;
const QUEUE_ADD_TIMEOUT_MS = 1_000;

export type CommercialOcrEnqueueResult = 'queued' | 'skipped' | 'failed';

export type CommercialOcrPendingActivation = Readonly<{
  jobId: string;
  chatId: string;
  imageCount: number;
  reservationTtlMs: number;
}>;

@Injectable()
export class CommercialOcrEnqueueService {
  private readonly logger = new Logger(CommercialOcrEnqueueService.name);

  constructor(
    @Optional()
    @InjectQueue(COMMERCIAL_OCR_QUEUE)
    private readonly queue?: Queue<CommercialOcrJob>,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly admissionStore?: CommercialOcrAdmissionStore,
  ) {}

  async enqueue(params: {
    webhookEventId: string;
    chatId: string;
    messageId: string;
    sourceCreatedAt: string;
    imageCount: number;
    actionEligible: boolean;
    registerPendingActivation?: (
      activation: CommercialOcrPendingActivation,
    ) => void | Promise<void>;
  }): Promise<CommercialOcrEnqueueResult> {
    const runtimePolicy = resolveCommercialOcrRuntimePolicy({
      chatId: params.chatId,
      configService: this.configService,
    });
    if (!runtimePolicy.process || !this.queue || !this.admissionStore) {
      return 'skipped';
    }

    const imageCount = validateCommercialOcrImageCount(params.imageCount);
    const ocrVersion = validateCommercialOcrVersion(
      this.configService?.get<string>('COMMERCIAL_OCR_VERSION') ?? COMMERCIAL_OCR_DEFAULT_VERSION,
    );
    const jobId = buildCommercialOcrJobId({
      chatId: params.chatId,
      messageId: params.messageId,
      sourceCreatedAt: params.sourceCreatedAt,
      ocrVersion,
    });
    const requestedActionEligible = normalizeCommercialOcrActionEligibility(params.actionEligible);
    const limits = this.resolveAdmissionLimits();
    if (!requestedActionEligible) {
      await this.admissionStore.suppress({
        jobId,
        chatId: params.chatId,
        imageCount,
        tombstoneTtlMs: limits.reservationTtlMs,
      });
      return 'skipped';
    }
    const reservation = await this.admissionStore.reserve({
      jobId,
      chatId: params.chatId,
      sourceCreatedAt: params.sourceCreatedAt,
      imageCount,
      actionEligible: requestedActionEligible && runtimePolicy.enforce,
      limits,
    });

    if (reservation.kind === 'unavailable') {
      return 'failed';
    }
    if (reservation.kind !== 'admitted' && reservation.kind !== 'duplicate') {
      return 'skipped';
    }

    // A prior suppression already absorbed this identity. A newly admitted observation is the
    // shadow-mode case and must still be analyzed.
    if (reservation.kind === 'duplicate' && reservation.state === 'observation') {
      return 'skipped';
    }
    const actionRequested = reservation.state !== 'observation';

    try {
      const createdAt = new Date().toISOString();
      await raceWithTimeout({
        operation: this.queue.add(
          COMMERCIAL_OCR_JOB_NAME,
          {
            webhookEventId: params.webhookEventId,
            chatId: params.chatId,
            messageId: params.messageId,
            sourceCreatedAt: params.sourceCreatedAt,
            imageCount,
            schemaVersion: COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
            ocrVersion,
            actionEligible: false,
            idempotencyKey: jobId,
            sourceTag: 'commercial-image-ocr',
            createdAt,
          },
          { ...COMMERCIAL_OCR_JOB_OPTIONS, jobId },
        ),
        timeoutMs: QUEUE_ADD_TIMEOUT_MS,
        onTimeout: () => {
          throw new Error(`Commercial OCR Queue.add timed out after ${QUEUE_ADD_TIMEOUT_MS}ms`);
        },
      });
      if (!actionRequested) {
        return 'queued';
      }
      const activation = {
        jobId,
        chatId: params.chatId,
        imageCount,
        reservationTtlMs: limits.reservationTtlMs,
      };
      if (params.registerPendingActivation) {
        await params.registerPendingActivation(activation);
      } else {
        await this.suppressPending(activation);
      }
      return 'queued';
    } catch (error: unknown) {
      // A timed-out Queue.add may still have created the job. Pending is already fail-open; the
      // tombstone also absorbs any concurrent or later activation when Redis is reachable.
      await this.admissionStore
        .suppress({
          jobId,
          chatId: params.chatId,
          imageCount,
          tombstoneTtlMs: limits.reservationTtlMs,
        })
        .catch(() => undefined);
      this.logger.warn(
        {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue commercial OCR analysis; moderation continues fail-open',
      );
      return 'failed';
    }
  }

  async activatePending(activation: CommercialOcrPendingActivation): Promise<boolean> {
    if (!this.admissionStore) {
      return false;
    }
    const result = await this.admissionStore.activate({
      jobId: activation.jobId,
      tombstoneTtlMs: activation.reservationTtlMs,
    });
    if (result === 'activated' || result === 'already_actionable') {
      return true;
    }
    if (result !== 'suppressed') {
      this.logger.warn(
        { jobId: activation.jobId, result },
        'Commercial OCR activation was not confirmed after webhook completion',
      );
      await this.suppressPending(activation).catch(() => false);
    }
    return false;
  }

  async activatePendingBatch(
    activations: readonly CommercialOcrPendingActivation[],
  ): Promise<void> {
    for (const activation of activations) {
      try {
        await this.activatePending(activation);
      } catch (error: unknown) {
        this.logger.warn(
          { jobId: activation.jobId, error: readErrorMessage(error) },
          'Commercial OCR activation failed after webhook completion; pending admission remains non-actionable',
        );
      }
    }
  }

  async suppressPending(activation: CommercialOcrPendingActivation): Promise<boolean> {
    if (!this.admissionStore) {
      return false;
    }
    return (
      (await this.admissionStore.suppress({
        jobId: activation.jobId,
        chatId: activation.chatId,
        imageCount: activation.imageCount,
        tombstoneTtlMs: activation.reservationTtlMs,
      })) === 'suppressed'
    );
  }

  async suppressPendingBatch(
    activations: readonly CommercialOcrPendingActivation[],
  ): Promise<void> {
    for (const activation of activations) {
      try {
        await this.suppressPending(activation);
      } catch (error: unknown) {
        this.logger.warn(
          { jobId: activation.jobId, error: readErrorMessage(error) },
          'Commercial OCR suppression failed after webhook processing failure; pending admission remains non-actionable',
        );
      }
    }
  }

  private resolveAdmissionLimits() {
    return {
      maxGlobalImageUnits: this.readPositiveInt(
        'COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS',
        DEFAULT_MAX_GLOBAL_IMAGE_UNITS,
      ),
      maxChatImageUnits: this.readPositiveInt(
        'COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS',
        DEFAULT_MAX_CHAT_IMAGE_UNITS,
      ),
      maxJobAgeMs: this.readPositiveInt('COMMERCIAL_OCR_MAX_JOB_AGE_MS', DEFAULT_MAX_JOB_AGE_MS),
      reservationTtlMs: this.readPositiveInt(
        'COMMERCIAL_OCR_RESERVATION_TTL_MS',
        DEFAULT_RESERVATION_TTL_MS,
      ),
    };
  }

  private readPositiveInt(key: string, fallback: number): number {
    const value = Number(this.configService?.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
