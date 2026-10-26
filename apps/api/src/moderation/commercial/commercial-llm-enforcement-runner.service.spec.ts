import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import type { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { CommercialLlmEnforcementRunnerService } from './commercial-llm-enforcement-runner.service';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import { CommercialLlmEnforcementMailbox } from './commercial-llm-enforcement.mailbox';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import { buildCommercialLlmOffer } from './commercial-llm-enforcement.protocol';
import type { CommercialLlmObservationResult } from './commercial-llm.protocol';
import * as shadowLease from './commercial-llm-shadow.lease';
import * as shadowProcessor from './commercial-llm-shadow.processor';

type ProcessorResult = Awaited<ReturnType<CommercialLlmEnforcementProcessor['run']>>;

const negative: CommercialLlmObservationResult = {
  classification: 'NOT_COMMERCIAL',
  reasonCodes: ['ORDINARY_DISCUSSION'],
  modelAlias: 'synthetic',
  modelSha256: 'synthetic',
  promptSha256: 'synthetic',
  runtimeVersion: 'synthetic',
  chatTemplateSha256: 'synthetic',
  policyVersion: 'synthetic',
  durationMs: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function source(chatId: string) {
  const now = Date.now();
  const offer = buildCommercialLlmOffer({
    chatId,
    messageId: `message-${chatId}`,
    userId: 'user',
    originBotId: 'bot',
    text: 'Обсуждение объявления в чате.',
    eventAt: new Date(now).toISOString(),
    settings: {
      commercialAdsFilterEnabled: true,
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
      nightModeTimezone: 'Europe/Moscow',
      textFiltersWarnEnabled: true,
      textFiltersMuteEnabled: true,
      textFiltersBanEnabled: true,
      textFiltersMuteDurationHours: 1,
      textFiltersBotMessageEnabled: true,
    },
    origin: {
      sourceWebhookEventId: `receipt-${chatId}`,
      sourceReceivingBotId: 'bot',
      sourceExecutionBotId: 'bot',
      sourceEventAtMs: now,
      sourceEvidenceVersion: 1,
    },
  });
  if (!offer) throw new Error('Synthetic current source required');
  return offer;
}

describe('commercial AI runner resource lifecycle', () => {
  let runner: CommercialLlmEnforcementRunnerService | null;
  let redis: Redis;
  let mailbox: CommercialLlmEnforcementMailbox;
  let cleanups: Array<() => void>;
  const governor = {
    decide: jest.fn<
      ReturnType<BackgroundRuntimeGovernorService['decide']>,
      Parameters<BackgroundRuntimeGovernorService['decide']>
    >(),
  } satisfies Pick<BackgroundRuntimeGovernorService, 'decide'>;
  const intents = {
    ensureIntent: jest.fn<
      ReturnType<ModerationDeleteIntentService['ensureIntent']>,
      Parameters<ModerationDeleteIntentService['ensureIntent']>
    >(),
  } satisfies Pick<ModerationDeleteIntentService, 'ensureIntent'>;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-27T09:00:00.000Z') });
    cleanups = [];
    const config = new ConfigService({
      APP_SERVICE_NAME: 'api-moderation-background',
      COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true,
      COMMERCIAL_LLM_ENDPOINT: 'http://127.0.0.1:1',
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    redis = shadowLease.createCommercialLlmRedis('redis://127.0.0.1:1');
    redis.status = 'ready';
    jest.spyOn(redis, 'connect').mockResolvedValue(undefined);
    jest.spyOn(redis, 'disconnect').mockImplementation(() => undefined);
    jest.spyOn(redis, 'set').mockResolvedValue('OK');
    jest.spyOn(shadowLease, 'createCommercialLlmRedis').mockReturnValue(redis);
    jest.spyOn(shadowProcessor, 'commercialLlmHostHasHeadroom').mockResolvedValue(true);
    mailbox = new CommercialLlmEnforcementMailbox(redis);
    jest.spyOn(mailbox, 'heartbeat').mockResolvedValue(true);
    jest.spyOn(mailbox, 'advertise').mockResolvedValue(true);
    jest.spyOn(mailbox, 'readObservations').mockResolvedValue({});
    jest.spyOn(mailbox, 'withdraw').mockResolvedValue(undefined);
    jest.spyOn(mailbox, 'releasePrimary').mockResolvedValue(true);
    const admission = new CommercialLlmEnforcementService(config);
    jest.spyOn(admission, 'mailbox').mockResolvedValue(mailbox);
    governor.decide
      .mockReset()
      .mockResolvedValue({ action: 'run', reason: 'normal', retryAfterMs: 0 });
    intents.ensureIntent.mockReset().mockRejectedValue(new Error('Unexpected delete registration'));
    runner = new CommercialLlmEnforcementRunnerService(
      config,
      admission,
      governor as unknown as BackgroundRuntimeGovernorService,
      intents as unknown as ModerationDeleteIntentService,
    );
  });

  afterEach(async () => {
    cleanups.forEach((complete) => complete());
    await jest.advanceTimersByTimeAsync(0);
    await runner?.onModuleDestroy();
    jest.restoreAllMocks();
    redis.disconnect();
    jest.useRealTimers();
  });

  function pendingJob() {
    const job = deferred<ProcessorResult>();
    cleanups.push(() => job.resolve({ outcome: 'idle' }));
    return job;
  }

  it('keeps heartbeats alive at three active jobs and admits a replacement only after completion', async () => {
    const jobs = [pendingJob(), pendingJob(), pendingJob(), pendingJob()];
    let next = 0;
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockImplementation(() => jobs[next++]?.promise ?? Promise.resolve({ outcome: 'idle' }));
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(8);
    const worker = run.mock.calls[0]![0];
    expect(jest.mocked(mailbox.heartbeat).mock.calls.every(([value]) => value === worker)).toBe(
      true,
    );
    expect(mailbox.withdraw).not.toHaveBeenCalled();

    jobs[0]!.resolve({ outcome: 'kept' });
    await jest.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(4);
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(9);
    expect(run.mock.calls[3]![0]).toBe(worker);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('aborts and drains actual work before withdrawing the worker or closing Redis', async () => {
    const job = pendingJob();
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockReturnValue(job.promise);
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    const signal = run.mock.calls[0]![1];
    const closing = runner!.onModuleDestroy();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(1);
    expect(mailbox.withdraw).not.toHaveBeenCalled();
    expect(redis.disconnect).not.toHaveBeenCalled();

    job.resolve({ outcome: 'source_expired' });
    await closing;
    expect(closed).toBe(true);
    expect(mailbox.withdraw).toHaveBeenCalledWith(run.mock.calls[0]![0]);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    runner = null;
  });

  it('releases primary before waiting on 9B and lets an independent primary start', async () => {
    const firstSecondary = deferred<CommercialLlmObservationResult>();
    const secondPrimary =
      deferred<Awaited<ReturnType<CommercialLlmWorkstationMailbox['classify']>>>();
    cleanups.push(() => firstSecondary.resolve(negative));
    cleanups.push(() => secondPrimary.resolve({ outcome: 'COMPLETE', result: negative }));
    const first = source('first-chat');
    const second = source('second-chat');
    const sources = [first, second];
    let next = 0;
    const take = jest.spyOn(mailbox, 'take').mockImplementation(async (worker) => {
      const offered = sources[next++];
      if (!offered) return null;
      const request = { ...offered, submittedAtMs: Date.now(), worker };
      return { request, raw: JSON.stringify(request) };
    });
    jest.spyOn(mailbox, 'owns').mockResolvedValue(true);
    jest.spyOn(mailbox, 'ownsWorker').mockResolvedValue(true);
    const finish = jest.spyOn(mailbox, 'finish').mockResolvedValue(undefined);
    const primary = jest
      .spyOn(CommercialLlmWorkstationMailbox.prototype, 'classify')
      .mockResolvedValueOnce({
        outcome: 'COMPLETE',
        result: { ...negative, classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] },
      })
      .mockReturnValueOnce(secondPrimary.promise);
    const secondary = jest
      .spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyWithin')
      .mockReturnValueOnce(firstSecondary.promise)
      .mockResolvedValue(negative);
    jest
      .spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyAudit')
      .mockResolvedValue(negative);

    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(secondary).toHaveBeenCalledTimes(1);
    const worker = take.mock.calls[0]![0];
    const releasedRaw = jest.mocked(mailbox.releasePrimary).mock.calls[0]![0];
    expect(JSON.parse(releasedRaw).source.chatId).toBe('first-chat');
    expect(mailbox.releasePrimary).toHaveBeenCalledWith(releasedRaw, worker);
    expect(finish).not.toHaveBeenCalled();
    expect(jest.mocked(mailbox.releasePrimary).mock.invocationCallOrder[0]).toBeLessThan(
      secondary.mock.invocationCallOrder[0]!,
    );

    await jest.advanceTimersByTimeAsync(250);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(take.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(finish).not.toHaveBeenCalledWith(releasedRaw, worker);
    expect(mailbox.releasePrimary).toHaveBeenCalledTimes(1);
    expect(intents.ensureIntent).not.toHaveBeenCalled();

    firstSecondary.resolve(negative);
    secondPrimary.resolve({ outcome: 'COMPLETE', result: negative });
    await jest.advanceTimersByTimeAsync(0);
    expect(finish).toHaveBeenCalledWith(releasedRaw, worker);
  });
});
