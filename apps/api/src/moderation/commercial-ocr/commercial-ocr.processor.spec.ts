import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

import { CommercialOcrProcessor } from './commercial-ocr.processor';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_JOB_ATTEMPTS,
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
  type CommercialOcrJob,
} from './commercial-ocr.queue';

const data = {
  webhookEventId: 'event-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  sourceCreatedAt: '2026-08-12T08:00:00.000Z',
  imageCount: 2,
  schemaVersion: COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
  ocrVersion: 'tesseract-rus-eng-v1',
  actionEligible: true,
  sourceTag: 'commercial-image-ocr',
  createdAt: '2026-08-12T08:00:01.000Z',
} satisfies Omit<CommercialOcrJob, 'idempotencyKey'>;

const jobId = buildCommercialOcrJobId(data);
const jobData: CommercialOcrJob = { ...data, idempotencyKey: jobId };
const sourceCreatedAtMs = Date.parse(data.sourceCreatedAt);
const maxJobAgeMs = 300_000;
const activeNowMs = sourceCreatedAtMs + 60_000;
const deadlineAtMs = sourceCreatedAtMs + maxJobAgeMs;

function createHarness(
  options: {
    result?: unknown;
    error?: Error;
    attemptsMade?: number;
    attempts?: number;
    jobOverrides?: Partial<Job<CommercialOcrJob>>;
    dataOverrides?: Partial<CommercialOcrJob>;
    currentOcrVersion?: string;
    releaseResult?: boolean;
  } = {},
) {
  const moderationService = {
    processCommercialOcrJob: options.error
      ? jest.fn().mockRejectedValue(options.error)
      : jest.fn().mockResolvedValue(options.result ?? { kind: 'completed' }),
  };
  const admissionStore = {
    release: jest.fn().mockResolvedValue(options.releaseResult ?? true),
  };
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'COMMERCIAL_OCR_VERSION') {
        return options.currentOcrVersion ?? 'tesseract-rus-eng-v1';
      }
      if (key === 'COMMERCIAL_OCR_MAX_JOB_AGE_MS') {
        return maxJobAgeMs;
      }
      return undefined;
    }),
  };
  const effectiveData = { ...jobData, ...options.dataOverrides };
  const job = {
    id: jobId,
    name: COMMERCIAL_OCR_JOB_NAME,
    data: effectiveData,
    opts: { attempts: options.attempts ?? COMMERCIAL_OCR_JOB_ATTEMPTS },
    attemptsMade: options.attemptsMade ?? 0,
    timestamp: Date.parse(data.createdAt),
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
    ...options.jobOverrides,
  } as unknown as Job<CommercialOcrJob>;
  const processor = new CommercialOcrProcessor(
    moderationService as never,
    admissionStore as never,
    configService as never,
  );
  return { processor, moderationService, admissionStore, configService, job };
}

describe('CommercialOcrProcessor', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(activeNowMs);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('validates the exact job identity and releases admission after terminal completion', async () => {
    const harness = createHarness();

    await expect(harness.processor.process(harness.job, 'lock-1')).resolves.toBeUndefined();

    expect(harness.moderationService.processCommercialOcrJob).toHaveBeenCalledWith(
      jobData,
      jobId,
      deadlineAtMs,
    );
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('drops an expired job before moderation I/O and releases its admission reservation', async () => {
    jest.mocked(Date.now).mockReturnValue(deadlineAtMs);
    const harness = createHarness();

    await expect(harness.processor.process(harness.job, 'lock-1')).resolves.toBeUndefined();

    expect(harness.moderationService.processCommercialOcrJob).not.toHaveBeenCalled();
    expect(harness.job.moveToDelayed).not.toHaveBeenCalled();
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it.each([
    ['name', { jobOverrides: { name: 'wrong-name' } }],
    [
      'schema',
      {
        dataOverrides: { schemaVersion: 2 as typeof COMMERCIAL_OCR_JOB_SCHEMA_VERSION },
      },
    ],
    ['job id', { jobOverrides: { id: `${jobId}-wrong` } }],
    ['idempotency key', { dataOverrides: { idempotencyKey: `${jobId}-wrong` } }],
    ['image count', { dataOverrides: { imageCount: 0 } }],
    ['configured OCR version', { currentOcrVersion: 'tesseract-rus-eng-v2' }],
    ['action eligibility', { dataOverrides: { actionEligible: 'true' as never } }],
  ])('rejects an invalid %s without consuming retries', async (label, overrides) => {
    const harness = createHarness(overrides);

    const error = await harness.processor.process(harness.job, 'lock-1').catch((caught) => caught);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(harness.moderationService.processCommercialOcrJob).not.toHaveBeenCalled();
    expect(harness.admissionStore.release).toHaveBeenCalledTimes(
      label === 'schema' || label === 'job id' || label === 'idempotency key' ? 0 : 1,
    );
  });

  it.each([
    'source_not_ready',
    'governor_pressure',
    'admission_pending',
  ] as const)('delays %s without consuming an attempt or releasing admission', async (reason) => {
    jest.mocked(Date.now).mockReturnValue(activeNowMs);
    const harness = createHarness({ result: { kind: 'defer', delayMs: 5_000, reason } });

    await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(harness.job.moveToDelayed).toHaveBeenCalledWith(activeNowMs + 5_000, 'lock-1');
    expect(harness.admissionStore.release).not.toHaveBeenCalled();
  });

  it('refuses a defer that would reach the absolute job deadline', async () => {
    jest.mocked(Date.now).mockReturnValue(deadlineAtMs - 5_000);
    const harness = createHarness({
      result: { kind: 'defer', delayMs: 5_000, reason: 'governor_pressure' },
    });

    const error = await harness.processor.process(harness.job, 'lock-1').catch((caught) => caught);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toHaveProperty(
      'message',
      'Commercial OCR job deadline exhausted: governor_pressure',
    );
    expect(harness.job.moveToDelayed).not.toHaveBeenCalled();
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('does not release admission after an ordinary retryable failure', async () => {
    const originalError = new Error('temporary failure');
    const harness = createHarness({ error: originalError, attemptsMade: 0, attempts: 3 });

    await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toBe(originalError);
    expect(harness.admissionStore.release).not.toHaveBeenCalled();
  });

  it('releases admission immediately when moderation reports an unrecoverable failure', async () => {
    const originalError = new UnrecoverableError('terminal failure');
    const harness = createHarness({ error: originalError, attemptsMade: 0, attempts: 3 });

    await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toBe(originalError);
    expect(harness.admissionStore.release).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it.each(['download_failed', 'ocr_failed'] as const)(
    'turns a %s retry result into a BullMQ failure',
    async (reason) => {
      const harness = createHarness({ result: { kind: 'retry', reason } });

      await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toThrow(
        `Commercial OCR transient failure: ${reason}`,
      );
      expect(harness.admissionStore.release).not.toHaveBeenCalled();
    },
  );

  it('releases admission when a retry result exhausts the final attempt', async () => {
    const harness = createHarness({
      result: { kind: 'retry', reason: 'ocr_failed' },
      attemptsMade: 2,
      attempts: 3,
    });

    await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toThrow(
      'Commercial OCR transient failure: ocr_failed',
    );
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('releases admission after a failure on the final attempt', async () => {
    const originalError = new Error('terminal failure');
    const harness = createHarness({ error: originalError, attemptsMade: 2, attempts: 3 });

    await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toBe(originalError);
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('keeps a successful defer reserved even on the nominal final attempt', async () => {
    const harness = createHarness({
      result: { kind: 'defer', delayMs: 5_000, reason: 'source_not_ready' },
      attemptsMade: 2,
      attempts: 3,
    });

    await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(harness.admissionStore.release).not.toHaveBeenCalled();
  });

  it('treats a failed final defer transition as terminal cleanup', async () => {
    const harness = createHarness({
      result: { kind: 'defer', delayMs: 5_000, reason: 'governor_pressure' },
      attemptsMade: 2,
      attempts: 3,
    });
    (harness.job.moveToDelayed as jest.Mock).mockRejectedValue(new Error('lock lost'));

    await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toThrow(
      'Commercial OCR job defer failed: governor_pressure',
    );
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('bounds and validates service defer results before touching BullMQ state', async () => {
    const harness = createHarness({
      result: { kind: 'defer', delayMs: 0, reason: 'source_not_ready' },
      attemptsMade: 2,
      attempts: 3,
    });

    const error = await harness.processor.process(harness.job, 'lock-1').catch((caught) => caught);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toHaveProperty(
      'message',
      'Commercial OCR moderation returned an invalid result',
    );
    expect(harness.job.moveToDelayed).not.toHaveBeenCalled();
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('does not retry completed OCR work only because best-effort release is unavailable', async () => {
    const harness = createHarness({ releaseResult: false });

    await expect(harness.processor.process(harness.job, 'lock-1')).resolves.toBeUndefined();
    expect(harness.admissionStore.release).toHaveBeenCalledTimes(1);
  });
});
