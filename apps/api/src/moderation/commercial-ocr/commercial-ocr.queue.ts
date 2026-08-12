import { createHash } from 'node:crypto';
import type { QueueJobEnvelope } from '../../common/queue-job-envelope';

export const COMMERCIAL_OCR_QUEUE = 'commercial-image-ocr';
export const COMMERCIAL_OCR_JOB_NAME = 'commercial-image-ocr-analysis';
export const COMMERCIAL_OCR_JOB_SCHEMA_VERSION = 1 as const;
export const COMMERCIAL_OCR_DEFAULT_VERSION = 'tesseract-rus-eng-v1';
export const COMMERCIAL_OCR_JOB_ATTEMPTS = 3;
export const COMMERCIAL_OCR_JOB_BACKOFF_MS = 5_000;

export const COMMERCIAL_OCR_JOB_OPTIONS = Object.freeze({
  attempts: COMMERCIAL_OCR_JOB_ATTEMPTS,
  backoff: {
    type: 'exponential' as const,
    delay: COMMERCIAL_OCR_JOB_BACKOFF_MS,
  },
  removeOnComplete: true,
  removeOnFail: 1_000,
});

export type CommercialOcrJob = QueueJobEnvelope<
  {
    webhookEventId: string;
    chatId: string;
    messageId: string;
    sourceCreatedAt: string;
    imageCount: number;
    schemaVersion: typeof COMMERCIAL_OCR_JOB_SCHEMA_VERSION;
    ocrVersion: string;
    actionEligible: boolean;
  },
  {
    idempotencyKey: string;
    sourceTag: 'commercial-image-ocr';
    createdAt: string;
  }
>;

export function buildCommercialOcrJobId(params: {
  chatId: string;
  messageId: string;
  sourceCreatedAt: string;
  ocrVersion: string;
  schemaVersion?: number;
}): string {
  const chatId = validateIdentifier(params.chatId, 'chatId');
  const messageId = validateIdentifier(params.messageId, 'messageId');
  const sourceCreatedAtMs = Date.parse(params.sourceCreatedAt);
  if (!Number.isSafeInteger(sourceCreatedAtMs) || sourceCreatedAtMs <= 0) {
    throw new Error('sourceCreatedAt is invalid');
  }
  const ocrVersion = validateOcrVersion(params.ocrVersion);
  const schemaVersion = params.schemaVersion ?? COMMERCIAL_OCR_JOB_SCHEMA_VERSION;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
    throw new Error('schemaVersion is invalid');
  }

  // FLAG: Eligibility is absent from identity so a stricter replay targets the same job. Admission
  // stores the absorbing eligibility latch that the worker must re-read before an action.
  const digest = createHash('sha256')
    .update(chatId)
    .update('\0')
    .update(messageId)
    .update('\0')
    .update(String(sourceCreatedAtMs))
    .update('\0')
    .update(String(schemaVersion))
    .update('\0')
    .update(ocrVersion)
    .digest('hex');
  return `commercial-image-ocr__${digest}`;
}

export function normalizeCommercialOcrActionEligibility(value: unknown): boolean {
  return value === true;
}

export function validateCommercialOcrImageCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error('imageCount is invalid');
  }
  return value;
}

export function validateCommercialOcrVersion(value: string): string {
  return validateOcrVersion(value);
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function validateOcrVersion(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error('ocrVersion is invalid');
  }
  return normalized;
}
