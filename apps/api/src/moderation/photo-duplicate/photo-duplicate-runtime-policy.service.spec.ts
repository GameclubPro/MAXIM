import {
  parsePhotoDuplicateRuntimeControl,
  PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY,
  PHOTO_DUPLICATE_RUNTIME_CONTROL_REDIS_OPTIONS,
  PHOTO_DUPLICATE_RUNTIME_CONTROL_REVISION_KEY,
  PhotoDuplicateRuntimePolicyService,
  PhotoDuplicateRuntimeControlValidationError,
  type PhotoDuplicateRuntimeControlV1,
} from './photo-duplicate-runtime-policy.service';

function buildControl(
  overrides: Partial<PhotoDuplicateRuntimeControlV1> = {},
): PhotoDuplicateRuntimeControlV1 {
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const updatedAt = new Date(Date.now() - 30_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    version: 1,
    revision: 7,
    mode: 'full',
    enforcementChatIds: ['chat-1'],
    advancedCanaryChatIds: ['chat-1'],
    allowedMatchKinds: ['canonical_sha256', 'pdq'],
    maxAction: 'MUTE',
    actor: 'safety-desk:user-1',
    reason: 'bounded photo duplicate canary',
    createdAt,
    updatedAt,
    expiresAt,
    ...overrides,
  };
}

function createService(params: {
  control?: PhotoDuplicateRuntimeControlV1 | string | null;
  readError?: Error;
  evalResult?: unknown;
  storedRevision?: string | null;
  env?: Record<string, unknown>;
}) {
  const rawControl =
    typeof params.control === 'string'
      ? params.control
      : params.control === null || params.control === undefined
        ? null
        : JSON.stringify(params.control);
  const storedRevision =
    params.storedRevision !== undefined
      ? params.storedRevision
      : params.control && typeof params.control !== 'string'
        ? String(params.control.revision)
        : null;
  const redis = {
    status: 'ready',
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    get: params.readError
      ? jest.fn().mockRejectedValue(params.readError)
      : jest.fn().mockResolvedValue(rawControl),
    mget: params.readError
      ? jest.fn().mockRejectedValue(params.readError)
      : jest.fn().mockResolvedValue([rawControl, storedRevision]),
    eval: jest.fn().mockResolvedValue(params.evalResult ?? [1, 1]),
    quit: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
    PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
    PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS: 'chat-1',
    PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'canonical_sha256,pdq',
    PHOTO_DUPLICATE_MAX_ACTION: 'BAN',
    ...params.env,
  };
  const service = Object.create(
    PhotoDuplicateRuntimePolicyService.prototype,
  ) as PhotoDuplicateRuntimePolicyService;
  Object.defineProperties(service, {
    redis: { value: redis },
    configService: { value: { get: (key: string) => config[key as keyof typeof config] } },
    logger: { value: { warn: jest.fn() } },
    lastFailureLogAtMs: { value: 0, writable: true },
  });
  return { redis, service };
}

const basicPolicyInput = {
  chatId: 'chat-1',
  preset: 'SAME_IMAGE' as const,
  scope: 'SAME_AUTHOR' as const,
};

describe('PhotoDuplicateRuntimePolicyService', () => {
  it('uses bounded fail-fast Redis connection and command options', () => {
    expect(PHOTO_DUPLICATE_RUNTIME_CONTROL_REDIS_OPTIONS).toEqual({
      commandTimeout: 750,
      connectTimeout: 750,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  });

  it('intersects the shared control with every env upper bound', async () => {
    const { service } = createService({
      control: buildControl({
        mode: 'full',
        allowedMatchKinds: ['canonical_sha256', 'pdq'],
        maxAction: 'BAN',
      }),
      env: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'delete_only',
        PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'canonical_sha256',
        PHOTO_DUPLICATE_MAX_ACTION: 'WARN',
      },
    });

    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toEqual({
      mode: 'delete_only',
      enforce: true,
      advancedCanary: true,
      allowedMatchKinds: ['canonical_sha256'],
      maxAction: 'WARN',
      controlRevision: 7,
      controlExpiresAt: expect.any(String),
    });
  });

  it.each([
    { label: 'missing', control: null },
    { label: 'malformed', control: '{broken-json' },
  ])('fails closed to shadow when the Redis control is $label', async ({ control }) => {
    const { service } = createService({ control });

    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
      controlRevision: null,
    });
  });

  it('fails closed to shadow when Redis cannot be read', async () => {
    const { service } = createService({ readError: new Error('redis unavailable') });

    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
      controlRevision: null,
    });
  });

  it('applies an explicit shared off switch', async () => {
    const { service } = createService({ control: buildControl({ mode: 'off' }) });

    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'off',
      enforce: false,
      controlRevision: 7,
    });
  });

  it('re-reads Redis on every policy resolution', async () => {
    const { redis, service } = createService({ control: buildControl() });
    redis.mget
      .mockResolvedValueOnce([
        JSON.stringify(buildControl({ revision: 8, mode: 'delete_only' })),
        '8',
      ])
      .mockResolvedValueOnce([JSON.stringify(buildControl({ revision: 9, mode: 'off' })), '9']);

    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'delete_only',
      enforce: true,
      controlRevision: 8,
    });
    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'off',
      enforce: false,
      controlRevision: 9,
    });
    expect(redis.mget).toHaveBeenCalledTimes(2);
  });

  it('does not consult Redis when the env upper bound is already shadow', async () => {
    const { redis, service } = createService({
      control: buildControl(),
      env: { PHOTO_DUPLICATE_ROLLOUT_MODE: 'shadow' },
    });

    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
    });
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('rejects wildcard and control-character chat allowlists', async () => {
    const wildcardControl = buildControl({ enforcementChatIds: ['*'] });
    expect(parsePhotoDuplicateRuntimeControl(JSON.stringify(wildcardControl))).toBeNull();
    expect(
      parsePhotoDuplicateRuntimeControl(
        JSON.stringify(buildControl({ enforcementChatIds: ['chat-1\nchat-2'] })),
      ),
    ).toBeNull();

    const { service } = createService({ control: wildcardControl });
    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
      controlRevision: null,
    });
  });

  it('rejects reserved non-enforceable match kinds in operator controls', () => {
    const control = buildControl({ allowedMatchKinds: ['platform_id'] as never });

    expect(parsePhotoDuplicateRuntimeControl(JSON.stringify(control))).toBeNull();
  });

  it('requires an exact shared advanced canary for perceptual or chat-wide matching', async () => {
    const { service } = createService({
      control: buildControl({ advancedCanaryChatIds: [] }),
    });

    await expect(
      service.resolveEffectivePolicy({
        chatId: 'chat-1',
        preset: 'MINOR_EDITS',
        scope: 'SAME_AUTHOR',
      }),
    ).resolves.toMatchObject({ mode: 'shadow', enforce: false });
  });

  it('writes a schema-validated first revision with an expiry-bound Redis TTL', async () => {
    const control = buildControl({ revision: 1 });
    const { redis, service } = createService({ evalResult: [1, 1] });

    await expect(service.setControl({ expectedRevision: null, control })).resolves.toEqual({
      kind: 'applied',
      revision: 1,
      expiresAt: control.expiresAt,
    });

    const [script, keyCount, key, revisionKey, expectedRevision, nextRevision, raw, ttl] =
      redis.eval.mock.calls[0]!;
    expect(String(script)).toContain("redis.call('SET', KEYS[1], ARGV[3], 'PX', ttl_ms)");
    expect([keyCount, key, revisionKey, expectedRevision, nextRevision]).toEqual([
      2,
      PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY,
      PHOTO_DUPLICATE_RUNTIME_CONTROL_REVISION_KEY,
      '-1',
      '1',
    ]);
    expect(JSON.parse(String(raw))).toEqual(control);
    expect(Number(ttl)).toBeGreaterThan(0);
    expect(Number(ttl)).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it('returns the current revision when the Redis compare-and-set conflicts', async () => {
    const control = buildControl({ revision: 8 });
    const { service } = createService({ evalResult: [0, 9] });

    await expect(service.setControl({ expectedRevision: 7, control })).resolves.toEqual({
      kind: 'conflict',
      currentRevision: 9,
    });
  });

  it('fails closed when SET sees an active control without its persistent revision fence', async () => {
    const control = buildControl({ revision: 1 });
    const { redis, service } = createService({ evalResult: [-1, -1] });

    await expect(service.setControl({ expectedRevision: null, control })).rejects.toThrow(
      'Redis contains an invalid photo duplicate runtime control',
    );

    const script = String(redis.eval.mock.calls[0]?.[0]);
    const missingFenceGuard = script.indexOf('if current_raw and not revision_raw then');
    expect(missingFenceGuard).toBeGreaterThanOrEqual(0);
    expect(missingFenceGuard).toBeLessThan(script.indexOf('current_revision = active_revision'));
  });

  it('clears only the expected control revision through Redis CAS', async () => {
    const { redis, service } = createService({ evalResult: [1, 8, 9] });

    await expect(service.clearControl({ expectedRevision: 8 })).resolves.toEqual({
      kind: 'cleared',
      previousRevision: 8,
      revision: 9,
    });

    const [script, keyCount, key, revisionKey, expectedRevision] = redis.eval.mock.calls[0]!;
    expect(String(script)).toContain("redis.call('DEL', KEYS[1])");
    expect(String(script)).toContain("redis.call('SET', KEYS[2], tostring(current_revision + 1))");
    expect([keyCount, key, revisionKey, expectedRevision]).toEqual([
      2,
      PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY,
      PHOTO_DUPLICATE_RUNTIME_CONTROL_REVISION_KEY,
      '8',
    ]);
  });

  it('reports a clear conflict without deleting a newer control', async () => {
    const { service } = createService({ evalResult: [0, 9] });

    await expect(service.clearControl({ expectedRevision: 8 })).resolves.toEqual({
      kind: 'conflict',
      currentRevision: 9,
    });
  });

  it('fails closed when CLEAR sees an active control without its persistent revision fence', async () => {
    const { redis, service } = createService({ evalResult: [-1, -1] });

    await expect(service.clearControl({ expectedRevision: 8 })).rejects.toThrow(
      'Redis contains an invalid photo duplicate runtime control',
    );

    const script = String(redis.eval.mock.calls[0]?.[0]);
    const missingFenceGuard = script.indexOf('if current_raw and not revision_raw then');
    expect(missingFenceGuard).toBeGreaterThanOrEqual(0);
    expect(missingFenceGuard).toBeLessThan(script.indexOf('current_revision = active_revision'));
  });

  it('rejects clear when the persistent revision can no longer be incremented safely', async () => {
    const { redis, service } = createService({});

    await expect(
      service.clearControl({ expectedRevision: Number.MAX_SAFE_INTEGER }),
    ).rejects.toBeInstanceOf(PhotoDuplicateRuntimeControlValidationError);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('continues the revision fence after clear or active-control expiry', async () => {
    const { service } = createService({
      control: null,
      storedRevision: '9',
      evalResult: [1, 10],
    });

    await expect(service.getControlSnapshot()).resolves.toEqual({
      kind: 'missing',
      control: null,
      revision: 9,
    });
    await expect(
      service.setControl({
        expectedRevision: 9,
        control: buildControl({ revision: 10 }),
      }),
    ).resolves.toMatchObject({ kind: 'applied', revision: 10 });
  });

  it('returns a sanitized control snapshot without exposing invalid Redis payloads', async () => {
    const active = buildControl();
    const activeHarness = createService({ control: active });
    const invalidHarness = createService({ control: '{"token":"must-not-leak"}' });

    await expect(activeHarness.service.getControlSnapshot()).resolves.toEqual({
      kind: 'active',
      control: active,
      revision: 7,
    });
    await expect(invalidHarness.service.getControlSnapshot()).resolves.toEqual({
      kind: 'invalid',
      control: null,
      revision: null,
    });
  });

  it('fails closed when an active control has no persistent revision fence', async () => {
    const control = buildControl();
    const { service } = createService({ control, storedRevision: null });

    await expect(service.getControlSnapshot()).resolves.toEqual({
      kind: 'invalid',
      control: null,
      revision: 7,
    });
    await expect(service.resolveEffectivePolicy(basicPolicyInput)).resolves.toMatchObject({
      mode: 'shadow',
      enforce: false,
      controlRevision: null,
    });
  });

  it('requires the control revision to advance exactly once', async () => {
    const { redis, service } = createService({});

    await expect(
      service.setControl({ expectedRevision: 7, control: buildControl({ revision: 9 }) }),
    ).rejects.toBeInstanceOf(PhotoDuplicateRuntimeControlValidationError);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'mode',
      control: buildControl({ revision: 1, mode: 'full' }),
      env: { PHOTO_DUPLICATE_ROLLOUT_MODE: 'delete_only' },
    },
    {
      label: 'enforcement chats',
      control: buildControl({ revision: 1 }),
      env: { PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-2' },
    },
    {
      label: 'advanced chats',
      control: buildControl({ revision: 1 }),
      env: { PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS: '' },
    },
    {
      label: 'match kinds',
      control: buildControl({ revision: 1 }),
      env: { PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'canonical_sha256' },
    },
    {
      label: 'max action',
      control: buildControl({ revision: 1 }),
      env: { PHOTO_DUPLICATE_MAX_ACTION: 'DELETE_MESSAGE' },
    },
  ])('rejects a CAS control that exceeds the env $label ceiling', async ({ control, env }) => {
    const { redis, service } = createService({ env });

    await expect(service.setControl({ expectedRevision: null, control })).rejects.toBeInstanceOf(
      PhotoDuplicateRuntimeControlValidationError,
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects a control whose audit lifetime exceeds 24 hours', async () => {
    const control = buildControl({
      revision: 1,
      expiresAt: new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
    });
    const { redis, service } = createService({});

    await expect(service.setControl({ expectedRevision: null, control })).rejects.toBeInstanceOf(
      PhotoDuplicateRuntimeControlValidationError,
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
