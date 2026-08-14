import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';

import { resolveCommercialOcrApprovalKeyIdSha256 } from './commercial-ocr-approval-key';
import { digestCommercialOcrSettingsFingerprintSet } from './commercial-ocr-settings-profile';

import {
  COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION,
  COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
  COMMERCIAL_OCR_RUNTIME_CONTROL_REDIS_OPTIONS,
  COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY,
  CommercialOcrRuntimeControlValidationError,
  CommercialOcrRuntimePolicyService,
  parseCommercialOcrRuntimeControl,
  type CommercialOcrRuntimeControlV1,
} from './commercial-ocr-runtime-policy.service';

const now = Date.parse('2026-08-13T08:00:00.000Z');
const certifiedSettingsFingerprint = 'a'.repeat(64);
const certificationSha256 = 'b'.repeat(64);
const certificationExpiresAt = new Date(now + 24 * 60 * 60_000).toISOString();
const behaviorIdentitySha256 = 'd'.repeat(64);
const approvalPublicKeyBase64 = generateKeyPairSync('ed25519').publicKey.export({
  type: 'spki',
  format: 'der',
}).toString('base64');
const rotatedApprovalPublicKeyBase64 = generateKeyPairSync('ed25519').publicKey.export({
  type: 'spki',
  format: 'der',
}).toString('base64');
const approvalKeyIdSha256 = resolveCommercialOcrApprovalKeyIdSha256(approvalPublicKeyBase64)!;

function control(
  overrides: Partial<CommercialOcrRuntimeControlV1> = {},
): CommercialOcrRuntimeControlV1 {
  return {
    version: 1,
    revision: 1,
    mode: 'canary',
    enforcementChatIds: ['chat-1'],
    certificationSha256,
    certificationExpiresAt,
    approvalKeyIdSha256,
    behaviorIdentitySha256,
    certifiedSettingsFingerprints: [certifiedSettingsFingerprint],
    certifiedSettingsFingerprintSetSha256: digestCommercialOcrSettingsFingerprintSet([
      certifiedSettingsFingerprint,
    ]),
    actor: 'operator@example.test',
    reason: 'reviewed OCR canary window',
    createdAt: new Date(now - 1_000).toISOString(),
    updatedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
}

function policyInput(chatId = 'chat-1', settingsFingerprint = certifiedSettingsFingerprint) {
  return { chatId, settingsFingerprint };
}

function buildService(
  env: Record<string, unknown> = {
    REDIS_URL: 'redis://127.0.0.1:6379',
    COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
    COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1,chat-2',
    COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64: approvalPublicKeyBase64,
  },
) {
  const service = new CommercialOcrRuntimePolicyService(new ConfigService(env));
  Object.defineProperty(service, 'behaviorIdentitySha256', {
    configurable: true,
    value: behaviorIdentitySha256,
  });
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

  it('requires exact certification metadata and a sorted fingerprint set', () => {
    const secondFingerprint = 'c'.repeat(64);
    const sortedFingerprints = [certifiedSettingsFingerprint, secondFingerprint];

    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(
          control({
            certifiedSettingsFingerprints: sortedFingerprints,
            certifiedSettingsFingerprintSetSha256:
              digestCommercialOcrSettingsFingerprintSet(sortedFingerprints),
          }),
        ),
      ),
    ).not.toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(
          control({
            certifiedSettingsFingerprints: [...sortedFingerprints].reverse(),
            certifiedSettingsFingerprintSetSha256:
              digestCommercialOcrSettingsFingerprintSet(sortedFingerprints),
          }),
        ),
      ),
    ).toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(control({ certifiedSettingsFingerprintSetSha256: 'd'.repeat(64) })),
      ),
    ).toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(control({ certificationSha256: 'not-a-digest' })),
      ),
    ).toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(control({ approvalKeyIdSha256: 'not-a-digest' })),
      ),
    ).toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(control({ behaviorIdentitySha256: 'not-a-digest' })),
      ),
    ).toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(control({ certificationExpiresAt: 'not-a-timestamp' })),
      ),
    ).toBeNull();
    expect(
      parseCommercialOcrRuntimeControl(
        JSON.stringify(
          control({
            certificationExpiresAt: new Date(now + 30_000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
          }),
        ),
      ),
    ).toBeNull();
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

  it('reserves enough revision headroom for every accepted control to be cleared', async () => {
    const service = buildService();
    const maximumActiveRevision = COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION + 1;
    const redis = installRedis(service, {
      status: 'ready',
      eval: jest.fn().mockResolvedValue([1, maximumActiveRevision, maximumActiveRevision + 1]),
    });

    expect(() =>
      service.previewSetControl({
        expectedRevision: COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION,
        control: control({ revision: maximumActiveRevision }),
      }),
    ).not.toThrow();
    expect(() =>
      service.previewSetControl({
        expectedRevision: COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION + 1,
        control: control({ revision: Number.MAX_SAFE_INTEGER }),
      }),
    ).toThrow(CommercialOcrRuntimeControlValidationError);
    await expect(
      service.clearControl({ expectedRevision: maximumActiveRevision }),
    ).resolves.toEqual({
      kind: 'cleared',
      previousRevision: maximumActiveRevision,
      revision: Number.MAX_SAFE_INTEGER,
    });
    await expect(
      service.clearControl({ expectedRevision: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow(CommercialOcrRuntimeControlValidationError);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval.mock.calls[0]?.slice(-2)).toEqual([
      String(maximumActiveRevision),
      String(Number.MAX_SAFE_INTEGER),
    ]);
  });

  it('fails closed to shadow when an enforcing env has no fresh shared control', async () => {
    const service = buildService();
    jest.spyOn(service, 'getControlSnapshot').mockResolvedValue({
      kind: 'missing',
      control: null,
      revision: null,
    });

    await expect(service.resolveEffectivePolicy(policyInput())).resolves.toEqual({
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

      await expect(service.resolveEffectivePolicy(policyInput())).resolves.toMatchObject({
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

    await expect(service.resolveEffectivePolicy(policyInput())).resolves.toMatchObject({
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

    await expect(service.resolveEffectivePolicy(policyInput())).resolves.toMatchObject({
      mode: 'canary',
      process: true,
      enforce: true,
      controlRevision: 1,
      enforcementAuthority: 'authorized',
    });
    await expect(service.resolveEffectivePolicy(policyInput('chat-2'))).resolves.toMatchObject({
      mode: 'shadow',
      process: true,
      enforce: false,
      controlRevision: 1,
      enforcementAuthority: 'revoked',
    });
  });

  it('revokes canary enforcement when current settings are not certified', async () => {
    const service = buildService();
    jest.spyOn(service, 'getControlSnapshot').mockResolvedValue({
      kind: 'active',
      control: control(),
      revision: 1,
    });

    await expect(
      service.resolveEffectivePolicy(policyInput('chat-1', 'f'.repeat(64))),
    ).resolves.toMatchObject({
      mode: 'shadow',
      process: true,
      enforce: false,
      controlRevision: 1,
      enforcementAuthority: 'revoked',
    });
    await expect(
      service.resolveEffectivePolicy(policyInput('chat-1', 'invalid')),
    ).resolves.toMatchObject({ enforce: false, enforcementAuthority: 'revoked' });
  });

  it('revokes an old control after the approval trust anchor rotates', async () => {
    const service = buildService({
      REDIS_URL: 'redis://127.0.0.1:6379',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
      COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1,chat-2',
      COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64:
        rotatedApprovalPublicKeyBase64,
    });
    jest.spyOn(service, 'getControlSnapshot').mockResolvedValue({
      kind: 'active',
      control: control(),
      revision: 1,
    });

    await expect(service.resolveEffectivePolicy(policyInput())).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
      controlRevision: 1,
      enforcementAuthority: 'revoked',
    });
    expect(() => service.previewSetControl({ expectedRevision: null, control: control() })).toThrow(
      /approval key/u,
    );
  });

  it('revokes enforcement when the certified behavior differs from the active release', async () => {
    const service = buildService();
    jest.spyOn(service, 'getControlSnapshot').mockResolvedValue({
      kind: 'active',
      control: control({ behaviorIdentitySha256: 'e'.repeat(64) }),
      revision: 1,
    });

    await expect(service.resolveEffectivePolicy(policyInput())).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
      controlRevision: 1,
      enforcementAuthority: 'revoked',
    });
    expect(() =>
      service.previewSetControl({
        expectedRevision: null,
        control: control({ behaviorIdentitySha256: 'e'.repeat(64) }),
      }),
    ).toThrow(/behavior identity/u);
  });

  it('fails closed when the active native behavior identity is incomplete', async () => {
    const service = buildService();
    Object.defineProperty(service, 'behaviorIdentitySha256', {
      configurable: true,
      value: null,
    });
    jest.spyOn(service, 'getControlSnapshot').mockResolvedValue({
      kind: 'active',
      control: control(),
      revision: 1,
    });

    await expect(service.resolveEffectivePolicy(policyInput())).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
      enforcementAuthority: 'revoked',
    });
    expect(() =>
      service.previewSetControl({ expectedRevision: null, control: control() }),
    ).toThrow(/behavior identity/u);
  });

  it('does not require Redis for env shadow processing', async () => {
    const service = buildService({
      REDIS_URL: 'redis://127.0.0.1:6379',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
    });
    const read = jest.spyOn(service, 'getControlSnapshot');

    await expect(service.resolveEffectivePolicy(policyInput())).resolves.toEqual({
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
      '2',
    ]);
    for (const call of redis.eval.mock.calls) {
      expect(String(call[0])).toContain("redis.call('SET', KEYS[2], ARGV[2])");
      expect(String(call[0])).not.toContain('tostring(');
    }
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
