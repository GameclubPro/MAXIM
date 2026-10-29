import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { HealthService, type OcrRuntimeReadinessSnapshot } from './health.service';
import {
  OCR_READINESS_HEARTBEAT_INTERVAL_MS,
  OcrReadinessHeartbeatService,
} from './ocr-readiness-heartbeat.service';
import { OcrReadinessStateModule } from './ocr-readiness-state.module';
import { OCR_READINESS_KEY, OcrReadinessStateService } from './ocr-readiness-state.service';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

const now = Date.parse('2026-10-29T10:00:00.000Z');
function readiness(): OcrRuntimeReadinessSnapshot {
  return {
    ok: true,
    timestamp: new Date(now).toISOString(),
    scope: 'ocr',
    checks: {
      ocr: {
        state: 'ready',
        ready: true,
        workers: { configured: 1, live: 1, ready: 1, busy: 0 },
        queueDepth: 0,
        bullMqTerminalDeadlineExhaustedProcess: null,
        behaviorIdentity: { required: true, complete: true, verified: true, state: 'verified' },
      },
    },
  };
}

describe('OCR readiness heartbeat writer', () => {
  function fixture(values: Record<string, unknown> = {}) {
    const config = new ConfigService({ APP_SERVICE_NAME: 'api-media-analysis', ...values });
    const health = { ocrReady: jest.fn(readiness) } satisfies Pick<HealthService, 'ocrReady'>;
    const state = {
      publish: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<OcrReadinessStateService, 'publish' | 'release'>;
    const writer = new OcrReadinessHeartbeatService(
      config,
      health as unknown as HealthService,
      state as unknown as OcrReadinessStateService,
    );
    return { writer, health, state };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['api-admin', 'api-media-analysis-extra', 'api-moderation', undefined])(
    'does not sample or publish from service %s',
    async (serviceName) => {
      const { writer, health, state } = fixture({ APP_SERVICE_NAME: serviceName });
      await writer.onModuleInit();
      await jest.advanceTimersByTimeAsync(15_000);
      await writer.onModuleDestroy();
      expect(health.ocrReady).not.toHaveBeenCalled();
      expect(state.publish).not.toHaveBeenCalled();
      expect(state.release).not.toHaveBeenCalled();
    },
  );

  it.each(['off', 'shadow', 'on'] as const)(
    'samples cached readiness with mode %s',
    async (mode) => {
      const { writer, health, state } = fixture({ IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: mode });
      await writer.onModuleInit();
      expect(health.ocrReady).toHaveBeenCalledTimes(1);
      expect(state.publish).toHaveBeenCalledWith({
        version: 1,
        serviceName: 'api-media-analysis',
        bootId: expect.any(String),
        observedAt: new Date(now).toISOString(),
        mode,
        ready: true,
        identityVerified: true,
      });
      await jest.advanceTimersByTimeAsync(OCR_READINESS_HEARTBEAT_INTERVAL_MS);
      expect(state.publish).toHaveBeenCalledTimes(2);
      const firstOwner = state.publish.mock.calls[0]?.[0]?.bootId;
      expect(state.publish.mock.calls[1]?.[0]?.bootId).toBe(firstOwner);
      await writer.onModuleDestroy();
      expect(state.release).toHaveBeenCalledWith(firstOwner);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(state.publish).toHaveBeenCalledTimes(2);
    },
  );

  it('defaults to shadow and fails closed for incomplete native identity', async () => {
    const { writer, health, state } = fixture();
    const sample = readiness();
    health.ocrReady.mockReturnValue({
      ...sample,
      checks: {
        ocr: {
          ...sample.checks.ocr,
          behaviorIdentity: { required: true, complete: false, verified: true, state: 'verified' },
        },
      },
    });
    await writer.onModuleInit();
    expect(state.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'shadow',
        ready: false,
        identityVerified: false,
      }),
    );
    await writer.onModuleDestroy();
  });

  it('does not make a failed diagnostic publication fail startup and retries on the timer', async () => {
    const { writer, state } = fixture();
    state.publish.mockRejectedValueOnce(new Error('redis://secret@private.example'));
    await expect(writer.onModuleInit()).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith('OCR readiness heartbeat unavailable');
    await jest.advanceTimersByTimeAsync(OCR_READINESS_HEARTBEAT_INTERVAL_MS);
    expect(state.publish).toHaveBeenCalledTimes(2);
    await writer.onModuleDestroy();
  });

  it('coalesces slow publication and waits for it before removing its observation', async () => {
    const { writer, state } = fixture();
    await writer.onModuleInit();
    let finish!: () => void;
    state.publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await jest.advanceTimersByTimeAsync(3 * OCR_READINESS_HEARTBEAT_INTERVAL_MS);
    expect(state.publish).toHaveBeenCalledTimes(2);
    const closing = writer.onModuleDestroy();
    await Promise.resolve();
    expect(state.release).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared Redis transport available until the writer destroy hook releases its owner', async () => {
    const events: string[] = [];
    const redis = {
      status: 'wait' as Redis['status'],
      on: jest.fn(),
      connect: jest.fn(async () => {
        redis.status = 'ready';
      }),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn(async () => {
        events.push('release');
        return 1;
      }),
      disconnect: jest.fn(() => {
        events.push('disconnect');
      }),
    } satisfies Pick<Redis, 'status' | 'on' | 'connect' | 'set' | 'eval' | 'disconnect'>;
    jest.mocked(Redis).mockImplementation(() => redis as unknown as Redis);
    @Module({
      imports: [OcrReadinessStateModule],
      providers: [
        OcrReadinessHeartbeatService,
        { provide: HealthService, useValue: { ocrReady: jest.fn(readiness) } },
      ],
    })
    class WriterModule {}
    const context = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [
            () => ({ APP_SERVICE_NAME: 'api-media-analysis', REDIS_URL: 'redis://localhost:1' }),
          ],
        }),
        WriterModule,
      ],
    }).compile();
    try {
      await context.init();
      expect(redis.set).toHaveBeenCalledWith(OCR_READINESS_KEY, expect.any(String), 'PX', 15_000);
    } finally {
      await context.close();
    }
    expect(events).toEqual(['release', 'disconnect']);
  });
});
