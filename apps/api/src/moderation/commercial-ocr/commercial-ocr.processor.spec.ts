import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

import { CommercialOcrModerationService } from './commercial-ocr-moderation.service';
import { CommercialOcrProcessor } from './commercial-ocr.processor';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_DEFAULT_VERSION,
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
  ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
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
      if (key === 'COMMERCIAL_OCR_MAX_JOB_AGE_MS') {
        return maxJobAgeMs;
      }
      return undefined;
    }),
  };
  const metrics = {
    recordQueueWait: jest.fn(),
    recordCounter: jest.fn(),
    recordStageDuration: jest.fn(),
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
    metrics as never,
  );
  return { processor, moderationService, admissionStore, configService, metrics, job };
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
    expect(harness.metrics.recordQueueWait).toHaveBeenCalledWith(
      activeNowMs - Date.parse(data.createdAt),
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('bullmq.job.started');
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('album.image_count.2_3');
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('bullmq.job.completed');
    expect(harness.metrics.recordStageDuration).toHaveBeenCalledWith(
      'end_to_end',
      expect.any(Number),
    );
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('does not record queue wait again after BullMQ has started a retry or defer', async () => {
    const harness = createHarness({
      jobOverrides: {
        attemptsStarted: 2,
        processedOn: activeNowMs,
      },
    });

    await expect(harness.processor.process(harness.job, 'lock-1')).resolves.toBeUndefined();

    expect(harness.metrics.recordQueueWait).not.toHaveBeenCalled();
  });

  it('completes a terminal OCR timeout without a BullMQ retry and releases admission', async () => {
    const admissionStore = {
      resolveState: jest.fn().mockResolvedValue({ kind: 'available', state: 'observation' }),
      release: jest.fn().mockResolvedValue(true),
    };
    const analysisService = {
      analyzeAlbum: jest.fn().mockResolvedValue({
        kind: 'incomplete',
        reason: 'ocr_timeout',
        imageIndex: 0,
        pass: 'primary',
      }),
    };
    const attachment = (photoId: string) => ({
      type: 'image',
      payload: { photo_id: photoId, url: `https://i.oneme.ru/${photoId}` },
    });
    const exactMessage = {
      id: data.messageId,
      timestamp: data.sourceCreatedAt,
      recipient: { chat_id: data.chatId },
      sender: { user_id: 'user-1', is_bot: false },
      body: {
        mid: data.messageId,
        text: 'Offer',
        attachments: [attachment('photo-1'), attachment('photo-2')],
      },
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          botId: 'bot-1',
          status: 'PROCESSED',
          nextEnqueueAt: null,
          normalizedPayload: {
            updateId: 'update-1',
            botId: 'bot-1',
            type: 'message_created',
            message: {
              messageId: data.messageId,
              chatId: data.chatId,
              senderId: 'user-1',
              text: 'Offer',
              createdAt: data.sourceCreatedAt,
            },
            raw: { message: exactMessage },
          },
          executionClaims: [{ executionBotId: 'bot-1' }],
        }),
      },
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: 'CHAT',
          settings: {
            commercialAdsFilterEnabled: true,
            commercialAdsSensitivity: 'BALANCED',
            commercialAdsWarnThreshold: 45,
            commercialAdsDeleteThreshold: 65,
            nightModeTimezone: 'Europe/Moscow',
          },
          admins: [],
        }),
      },
    };
    const maxClient = {
      getExactMessageRow: jest.fn().mockResolvedValue(exactMessage),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'COMMERCIAL_OCR_VERSION') return COMMERCIAL_OCR_DEFAULT_VERSION;
        if (key === 'COMMERCIAL_OCR_MAX_JOB_AGE_MS') return maxJobAgeMs;
        if (key === 'COMMERCIAL_OCR_ROLLOUT_MODE') return 'shadow';
        return undefined;
      }),
    };
    const moderationService = new CommercialOcrModerationService(
      prisma as never,
      analysisService as never,
      admissionStore as never,
      { decide: jest.fn() } as never,
      maxClient as never,
      {
        runWithBot: jest.fn(async (_botId: string, task: () => Promise<unknown>) => task()),
      } as never,
      {
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        getDefaultBotId: jest.fn().mockReturnValue('bot-1'),
      } as never,
      { consumeForMessage: jest.fn() } as never,
      { ensureIntentWithMessageActionClaim: jest.fn(), getRolloutForRule: jest.fn() } as never,
      { resolveEffectivePolicy: jest.fn() } as never,
      configService as never,
      { recordCounter: jest.fn() } as never,
    );
    const processor = new CommercialOcrProcessor(
      moderationService,
      admissionStore as never,
      configService as never,
      {
        recordQueueWait: jest.fn(),
        recordCounter: jest.fn(),
        recordStageDuration: jest.fn(),
      } as never,
    );
    const job = {
      id: jobId,
      name: COMMERCIAL_OCR_JOB_NAME,
      data: jobData,
      opts: { attempts: COMMERCIAL_OCR_JOB_ATTEMPTS },
      attemptsMade: 0,
      timestamp: Date.parse(data.createdAt),
      moveToDelayed: jest.fn(),
    } as unknown as Job<CommercialOcrJob>;

    await expect(processor.process(job, 'lock-1')).resolves.toBeUndefined();

    expect(analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(admissionStore.release).toHaveBeenCalledTimes(1);
    expect(admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: data.chatId });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
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

  it('rejects a validly identified job from an older behavior version', async () => {
    const staleData = { ...jobData, ocrVersion: 'tesseract-rus-eng-v1' };
    const staleJobId = buildCommercialOcrJobId(staleData);
    const harness = createHarness({
      dataOverrides: { ...staleData, idempotencyKey: staleJobId },
      jobOverrides: { id: staleJobId },
    });

    const error = await harness.processor.process(harness.job, 'lock-1').catch((caught) => caught);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toHaveProperty('message', 'Commercial OCR job version is stale');
    expect(harness.moderationService.processCommercialOcrJob).not.toHaveBeenCalled();
    expect(harness.admissionStore.release).toHaveBeenCalledWith({
      jobId: staleJobId,
      chatId: data.chatId,
    });
  });

  it.each(['source_not_ready', 'governor_pressure', 'admission_pending'] as const)(
    'delays %s without consuming an attempt or releasing admission',
    async (reason) => {
      jest.mocked(Date.now).mockReturnValue(activeNowMs);
      const harness = createHarness({ result: { kind: 'defer', delayMs: 5_000, reason } });

      await expect(harness.processor.process(harness.job, 'lock-1')).rejects.toBeInstanceOf(
        DelayedError,
      );

      expect(harness.job.moveToDelayed).toHaveBeenCalledWith(activeNowMs + 5_000, 'lock-1');
      expect(harness.metrics.recordCounter).toHaveBeenCalledWith(`bullmq.job.defer.${reason}`);
      expect(harness.admissionStore.release).not.toHaveBeenCalled();
    },
  );

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
      expect(harness.metrics.recordCounter).toHaveBeenCalledWith(`bullmq.job.retry.${reason}`);
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
    expect(error).toHaveProperty('message', 'Commercial OCR moderation returned an invalid result');
    expect(harness.job.moveToDelayed).not.toHaveBeenCalled();
    expect(harness.admissionStore.release).toHaveBeenCalledWith({ jobId, chatId: 'chat-1' });
  });

  it('does not retry completed OCR work only because best-effort release is unavailable', async () => {
    const harness = createHarness({ releaseResult: false });

    await expect(harness.processor.process(harness.job, 'lock-1')).resolves.toBeUndefined();
    expect(harness.admissionStore.release).toHaveBeenCalledTimes(1);
  });
});
