import { ConfigService } from '@nestjs/config';

import {
  COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
  COMMERCIAL_OCR_RUNTIME_CONTROL_REDIS_OPTIONS,
  COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY,
  CommercialOcrRuntimeControlValidationError,
  CommercialOcrRuntimePolicyService,
  parseCommercialOcrRuntimeControl,
  type CommercialOcrRuntimeControlV1,
} from './commercial-ocr-runtime-policy.service';

const now = Date.parse('2026-08-13T08:00:00.000Z');

function control(
  overrides: Partial<CommercialOcrRuntimeControlV1> = {},
): CommercialOcrRuntimeControlV1 {
  return {
    version: 1,
    revision: 1,
    mode: 'canary',
    enforcementChatIds: ['chat-1'],
    actor: 'operator@example.test',
    reason: 'reviewed OCR canary window',
    createdAt: new Date(now - 1_000).toISOString(),
    updatedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
}

function buildService(
  env: Record<string, unknown> = {
    REDIS_URL: 'redis://127.0.0.1:6379',
    COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
    COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1,chat-2',
  },
) {
  const service = new CommercialOcrRuntimePolicyService(new ConfigService(env));
  (service as any).redis.disconnect();
  return service;
}

function installRedis(
  service: CommercialOcrRuntimePolicyService,
  redis: {
    status: string;
    connect?: jest.Mock;
    eval: jest.Mock;
  },
) {
  Object.defineProperty(service, 'redis', { configurable: true, value: redis });
  return redis;
}

describe('CommercialOcrRuntimePolicyService', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses bounded Redis operations without reconnect resends', () => {
    expect(COMMERCIAL_OCR_RUNTIME_CONTROL_REDIS_OPTIONS).toEqual({
      autoResendUnfulfilledCommands: false,
      commandTimeout: 750,
      connectTimeout: 750,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  });

  it('parses only strict, exact-chat, bounded controls', () => {
    expect(parseCommercialOcrRuntimeControl(JSON.stringify(control()))).toEqual(control());
    expect(
      parseCommercialOcrRuntimeControl(JSON.stringify(control({ enforcementChatIds: ['*'] }))),
    ).toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(control({ expiresAt: new Date(now + 24 * 60 * 60_000 + 1).toISOString() })),
      ),
    ).toBeNull();
    expect(parseCommercialOcrRuntimeControl('{')).toBeNull();
  });

  it('rejects controls that exceed the env mode or canary allowlist', () => {
    const service = buildService();

    expect(() =>
      service.previewSetControl({ expectedRevision: null, control: control({ mode: 'on' }) }),
    ).toThrow(CommercialOcrRuntimeControlValidationError);
    expect(() =>
      service.previewSetControl({
        expectedRevision: null,
        control: control({ enforcementChatIds: ['chat-3'] }),
      }),
    ).toThrow(/COMMERCIAL_OCR_CANARY_CHAT_IDS/u);
  });

  it('requires an exact revision increment and a live expiry', () => {
    const service = buildService();

    expect(() =>
      service.previewSetControl({ expectedRevision: 2, control: control({ revision: 2 }) }),
    ).toThrow(/revision must be 3/u);
    expect(() =>
      service.previewSetControl({
        expectedRevision: null,
        control: control({ expiresAt: new Date(now).toISOString() }),
      }),
    ).toThrow(CommercialOcrRuntimeControlValidationError);
  });

  it('fails closed to shadow when an enforcing env has no fresh shared control', async () => {
    const service = buildService();
    jest.spyOn(service, 'getControlSnapshot').mockResolvedValue({
      kind: 'missing',
      control: null,
      revision: null,
    });

    await expect(service.resolveEffectivePolicy({ chatId: 'chat-1' })).resolves.toEqual({
      mode: 'shadow',
      process: true,
      enforce: false,
      controlRevision: null,
      controlExpiresAt: null,
      enforcementAuthority: 'revoked',
    });
  });

  it.each(['missing', 'invalid', 'expired'] as const)(
    'treats a %s shared control as an explicit revocation',
    async (kind) => {
      const service = buildService();
      const activeControl = control({ expiresAt: new Date(now - 1).toISOString() });
      jest
        .spyOn(service, 'getControlSnapshot')
        .mockResolvedValue(
          kind === 'missing'
            ? { kind, control: null, revision: null }
            : kind === 'invalid'
              ? { kind, control: null, revision: 1 }
              : { kind, control: activeControl, revision: 1 },
        );

      await expect(service.resolveEffectivePolicy({ chatId: 'chat-1' })).resolves.toMatchObject({
        mode: 'shadow',
        enforce: false,
        enforcementAuthority: 'revoked',
      });
    },
  );

  it('distinguishes a transient Redis read failure from a revoked control', async () => {
    const service = buildService();
    jest
      .spyOn(service, 'getControlSnapshot')
      .mockRejectedValue(new Error('Redis operation timed out'));

    await expect(service.resolveEffectivePolicy({ chatId: 'chat-1' })).resolves.toMatchObject({
      mode: 'shadow',
      process: true,
      enforce: false,
      enforcementAuthority: 'unavailable',
    });
  });

  it('intersects an active control with the env canary', async () => {
    const service = buildService();
    jest.spyOn(service, 'getControlSnapshot').mockResolvedValue({
      kind: 'active',
      control: control(),
      revision: 1,
    });

    await expect(service.resolveEffectivePolicy({ chatId: 'chat-1' })).resolves.toMatchObject({
      mode: 'canary',
      process: true,
      enforce: true,
      controlRevision: 1,
      enforcementAuthority: 'authorized',
    });
    await expect(service.resolveEffectivePolicy({ chatId: 'chat-2' })).resolves.toMatchObject({
      mode: 'shadow',
      process: true,
      enforce: false,
      controlRevision: 1,
      enforcementAuthority: 'revoked',
    });
  });

  it('does not require Redis for env shadow processing', async () => {
    const service = buildService({
      REDIS_URL: 'redis://127.0.0.1:6379',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
    });
    const read = jest.spyOn(service, 'getControlSnapshot');

    await expect(service.resolveEffectivePolicy({ chatId: 'chat-1' })).resolves.toEqual({
      mode: 'shadow',
      process: true,
      enforce: false,
      controlRevision: null,
      controlExpiresAt: null,
      enforcementAuthority: 'revoked',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('applies set and clear through one Redis EVAL each', async () => {
    const service = buildService();
    const redis = installRedis(service, {
      status: 'ready',
      eval: jest.fn().mockResolvedValueOnce([1, 1]).mockResolvedValueOnce([1, 1, 2]),
    });
    const proposed = control();

    await expect(
      service.setControl({ expectedRevision: null, control: proposed }),
    ).resolves.toEqual({
      kind: 'applied',
      revision: 1,
      expiresAt: proposed.expiresAt,
    });
    await expect(service.clearControl({ expectedRevision: 1 })).resolves.toEqual({
      kind: 'cleared',
      previousRevision: 1,
      revision: 2,
    });

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[0]?.slice(1, 6)).toEqual([
      2,
      COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
      COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY,
      '-1',
      '1',
    ]);
    expect(redis.eval.mock.calls[1]?.slice(1)).toEqual([
      2,
      COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
      COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY,
      '1',
    ]);
  });

  it.each(['set', 'clear'] as const)(
    'returns an ambiguous %s outcome when EVAL completes after the deadline without retrying it',
    async (command) => {
      jest.useFakeTimers();
      jest.setSystemTime(now);
      const service = buildService();
      let resolveEval!: (value: unknown) => void;
      const delayedEval = new Promise<unknown>((resolve) => {
        resolveEval = resolve;
      });
      const redis = installRedis(service, {
        status: 'ready',
        eval: jest.fn().mockReturnValue(delayedEval),
      });

      const pending =
        command === 'set'
          ? service.setControl({ expectedRevision: null, control: control() })
          : service.clearControl({ expectedRevision: 1 });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(750);

      await expect(pending).resolves.toEqual({
        kind: 'ambiguous',
        reason: 'mutation_timeout',
      });
      expect(redis.eval).toHaveBeenCalledTimes(1);

      resolveEval(command === 'set' ? [1, 1] : [1, 1, 2]);
      await Promise.resolve();
      expect(redis.eval).toHaveBeenCalledTimes(1);
    },
  );

  it('does not classify a connection failure before EVAL dispatch as ambiguous', async () => {
    const service = buildService();
    const redis = installRedis(service, {
      status: 'wait',
      connect: jest.fn().mockRejectedValue(new Error('connection refused')),
      eval: jest.fn(),
    });

    await expect(
      service.setControl({ expectedRevision: null, control: control() }),
    ).rejects.toThrow('connection refused');
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
