import {
  LEGACY_RECOVERY_LIVE_MAX_OWNERS,
  LEGACY_RECOVERY_LIVE_PROTOCOL_VERSION,
  LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES,
  legacyRecoveryLiveDigest,
  parseLegacyRecoveryLiveRequest,
} from './legacy-recovery-live-protocol';

// Match the current production release boundary: all shared-image API roles and both IPC workers.
const productionServices = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
  'ocr-native-sandbox',
  'photo-native-sandbox',
];

function requestFixture() {
  const sourceSha = 'a'.repeat(40);
  const imageId = `sha256:${'b'.repeat(64)}`;
  return {
    version: LEGACY_RECOVERY_LIVE_PROTOCOL_VERSION,
    operation: 'inventory_preview',
    binding: {
      maintenanceId: '11111111-1111-4111-8111-111111111111',
      queueFenceNonce: 'finite-review-nonce-20261006',
      transitionJournalSha256: 'c'.repeat(64),
      sourceSha,
      imageId,
      stoppedGenerations: productionServices.map((serviceName, index) => ({
        serviceName,
        containerId: (index + 1).toString(16).padStart(64, '0'),
        imageId,
        sourceSha,
        stopped: true,
      })),
    },
    selection: {
      ownerWebhookEventIds: ['owner-z', 'owner-a'],
      majorBotIds: ['bot-z', 'bot-a'],
    },
  };
}

function parse(value: unknown) {
  return parseLegacyRecoveryLiveRequest(JSON.stringify(value));
}

describe('finite legacy recovery live protocol', () => {
  it('accepts exactly the 14 API roles and two native auxiliary generations', () => {
    const parsed = parse(requestFixture());
    expect(parsed.binding.stoppedGenerations).toHaveLength(16);
    expect(parsed.binding.stoppedGenerations.map((row) => row.serviceName).sort()).toEqual(
      [...productionServices].sort(),
    );
    expect(parsed).toMatchObject({ version: 1, operation: 'inventory_preview' });
  });

  it.each([
    ['missing all generations', []],
    ['API roles only', requestFixture().binding.stoppedGenerations.slice(0, 14)],
    ['missing one API role', requestFixture().binding.stoppedGenerations.slice(1)],
    [
      'extra generation',
      [
        ...requestFixture().binding.stoppedGenerations,
        requestFixture().binding.stoppedGenerations[0],
      ],
    ],
    ['non-array generations', null],
  ])('rejects %s', (_label, stoppedGenerations) => {
    const request = requestFixture();
    expect(() =>
      parse({ ...request, binding: { ...request.binding, stoppedGenerations } }),
    ).toThrow();
  });

  it.each(['api-foreign', 'postgres', 'redis', 'miniapp-major-static', 'API-ADMIN'])(
    'rejects a foreign generation %s even at the exact service count',
    (serviceName) => {
      const request = requestFixture();
      request.binding.stoppedGenerations[0].serviceName = serviceName;
      expect(() => parse(request)).toThrow('Stopped-generation identity mismatch');
    },
  );

  it('rejects a duplicated service that conceals a missing service', () => {
    const request = requestFixture();
    request.binding.stoppedGenerations[1].serviceName = productionServices[0];
    expect(() => parse(request)).toThrow('Ambiguous stopped generations');
  });

  it('rejects one container reused for two service identities', () => {
    const request = requestFixture();
    request.binding.stoppedGenerations[1].containerId =
      request.binding.stoppedGenerations[0].containerId;
    expect(() => parse(request)).toThrow('Ambiguous stopped generations');
  });

  it.each(['api-action', 'ocr-native-sandbox', 'photo-native-sandbox'])(
    'rejects a different image or source for %s',
    (serviceName) => {
      for (const mismatch of [
        { imageId: `sha256:${'d'.repeat(64)}` },
        { sourceSha: 'e'.repeat(40) },
      ]) {
        const request = requestFixture();
        const index = productionServices.indexOf(serviceName);
        request.binding.stoppedGenerations[index] = {
          ...request.binding.stoppedGenerations[index],
          ...mismatch,
        };
        expect(() => parse(request)).toThrow('Stopped-generation identity mismatch');
      }
    },
  );

  it.each([
    { containerId: 'a'.repeat(63) },
    { containerId: 'A'.repeat(64) },
    { containerId: 'sha256:' + 'a'.repeat(64) },
    { imageId: 'b'.repeat(64) },
    { sourceSha: 'a'.repeat(39) },
    { stopped: false },
    { stopped: 'true' },
    { stopped: null },
    { containerId: null },
  ])('rejects malformed generation evidence %j', (change) => {
    const request = requestFixture();
    const stoppedGenerations = [...request.binding.stoppedGenerations];
    const first = { ...stoppedGenerations[0], ...change };
    expect(() =>
      parse({
        ...request,
        binding: {
          ...request.binding,
          stoppedGenerations: [first, ...stoppedGenerations.slice(1)],
        },
      }),
    ).toThrow();
  });

  it.each(['serviceName', 'containerId', 'imageId', 'sourceSha', 'stopped'])(
    'rejects missing generation evidence %s',
    (missing) => {
      const request = requestFixture();
      const first = Object.fromEntries(
        Object.entries(request.binding.stoppedGenerations[0]).filter(([key]) => key !== missing),
      );
      expect(() =>
        parse({
          ...request,
          binding: {
            ...request.binding,
            stoppedGenerations: [first, ...request.binding.stoppedGenerations.slice(1)],
          },
        }),
      ).toThrow();
    },
  );

  it.each([
    { maintenanceId: 'not-a-uuid' },
    { queueFenceNonce: 'short' },
    { queueFenceNonce: 'a'.repeat(129) },
    { transitionJournalSha256: 'C'.repeat(64) },
    { transitionJournalSha256: 'c'.repeat(63) },
    { sourceSha: 'A'.repeat(40) },
    { imageId: `sha256:${'B'.repeat(64)}` },
  ])('rejects malformed transition binding %j', (change) => {
    const request = requestFixture();
    expect(() => parse({ ...request, binding: { ...request.binding, ...change } })).toThrow();
  });

  it.each(['maintenanceId', 'queueFenceNonce', 'transitionJournalSha256', 'sourceSha', 'imageId'])(
    'rejects a binding without %s',
    (missing) => {
      const request = requestFixture();
      const binding = Object.fromEntries(
        Object.entries(request.binding).filter(([key]) => key !== missing),
      );
      expect(() => parse({ ...request, binding })).toThrow();
    },
  );

  it.each([null, [], 1, true, 'request'])('rejects non-object input %j', (value) => {
    expect(() => parse(value)).toThrow();
  });

  it.each([
    { version: 2 },
    { version: '1' },
    { operation: 'apply' },
    { expectedInventorySha256: null },
    { expectedInventorySha256: 'D'.repeat(64) },
  ])('rejects unsupported operation or expected digest %j', (change) => {
    expect(() => parse({ ...requestFixture(), ...change })).toThrow();
  });

  it('preserves a valid expected inventory digest', () => {
    const expectedInventorySha256 = 'd'.repeat(64);
    expect(parse({ ...requestFixture(), expectedInventorySha256 }).expectedInventorySha256).toBe(
      expectedInventorySha256,
    );
  });

  it.each(['request', 'binding', 'selection', 'generation'])(
    'rejects unknown fields in %s',
    (level) => {
      const request = requestFixture();
      let value: unknown = request;
      if (level === 'request') value = { ...request, applied: true };
      if (level === 'binding')
        value = { ...request, binding: { ...request.binding, authorized: true } };
      if (level === 'selection')
        value = { ...request, selection: { ...request.selection, all: true } };
      if (level === 'generation') {
        value = {
          ...request,
          binding: {
            ...request.binding,
            stoppedGenerations: [
              { ...request.binding.stoppedGenerations[0], running: false },
              ...request.binding.stoppedGenerations.slice(1),
            ],
          },
        };
      }
      expect(() => parse(value)).toThrow('Unknown offline inventory field');
    },
  );

  it.each(['binding', 'selection'])(
    'rejects arrays and null where the nested %s object is required',
    (field) => {
      for (const value of [[], null]) {
        expect(() => parse({ ...requestFixture(), [field]: value })).toThrow();
      }
    },
  );

  it.each(['ownerWebhookEventIds', 'majorBotIds'])(
    'rejects empty, duplicate, missing and malformed %s selections',
    (field) => {
      for (const value of [[], ['same', 'same'], null, ['foreign:id'], ['a'.repeat(129)], [1]]) {
        const request = requestFixture();
        expect(() =>
          parse({ ...request, selection: { ...request.selection, [field]: value } }),
        ).toThrow();
      }
      const request = requestFixture();
      const selection = Object.fromEntries(
        Object.entries(request.selection).filter(([key]) => key !== field),
      );
      expect(() => parse({ ...request, selection })).toThrow();
    },
  );

  it.each([
    ['ownerWebhookEventIds', LEGACY_RECOVERY_LIVE_MAX_OWNERS],
    ['majorBotIds', 100],
  ] as const)('enforces the finite %s budget of %i', (field, limit) => {
    const request = requestFixture();
    const values = Array.from({ length: limit }, (_, index) => `id-${index}`);
    expect(() =>
      parse({ ...request, selection: { ...request.selection, [field]: values } }),
    ).not.toThrow();
    expect(() =>
      parse({ ...request, selection: { ...request.selection, [field]: [...values, 'extra'] } }),
    ).toThrow();
  });

  it('sorts selections and generation evidence before computing a deterministic request digest', () => {
    const first = requestFixture();
    const second = requestFixture();
    second.binding.stoppedGenerations.reverse();
    second.selection.ownerWebhookEventIds.reverse();
    second.selection.majorBotIds.reverse();
    const parsedFirst = parse(first);
    const parsedSecond = parse(second);
    expect(parsedFirst.selection).toEqual({
      ownerWebhookEventIds: ['owner-a', 'owner-z'],
      majorBotIds: ['bot-a', 'bot-z'],
    });
    expect(parsedFirst.binding.stoppedGenerations.map((row) => row.serviceName)).toEqual(
      [...productionServices].sort(),
    );
    expect(parsedSecond).toEqual(parsedFirst);
    expect(legacyRecoveryLiveDigest(parsedSecond)).toBe(legacyRecoveryLiveDigest(parsedFirst));
  });

  it('returns an immutable request, including each generation and both selection arrays', () => {
    const parsed = parse(requestFixture());
    for (const value of [
      parsed,
      parsed.binding,
      parsed.binding.stoppedGenerations,
      ...parsed.binding.stoppedGenerations,
      parsed.selection,
      parsed.selection.ownerWebhookEventIds,
      parsed.selection.majorBotIds,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('accepts exactly 64 KiB and rejects the next byte before parsing', () => {
    const json = JSON.stringify(requestFixture());
    const padding = ' '.repeat(LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES - Buffer.byteLength(json));
    const exact = json + padding;
    expect(Buffer.byteLength(exact)).toBe(64 * 1024);
    expect(() => parseLegacyRecoveryLiveRequest(exact)).not.toThrow();
    expect(() => parseLegacyRecoveryLiveRequest(exact + ' ')).toThrow(
      'Offline request budget exceeded',
    );
    expect(() => parseLegacyRecoveryLiveRequest('!'.repeat(64 * 1024 + 1))).toThrow(
      'Offline request budget exceeded',
    );
  });

  it('measures the request byte budget as UTF-8 rather than JavaScript character count', () => {
    const request = requestFixture();
    request.selection.ownerWebhookEventIds = ['я'.repeat(32_768)];
    const json = JSON.stringify(request);
    expect(json.length).toBeLessThan(LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES);
    expect(Buffer.byteLength(json)).toBeGreaterThan(LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES);
    expect(() => parseLegacyRecoveryLiveRequest(json)).toThrow('Offline request budget exceeded');
  });
});

describe('legacy recovery live evidence digest', () => {
  it('canonicalizes nested object key order and Date values', () => {
    const first = { z: [{ b: 2, a: 1 }], a: new Date('2026-10-06T01:00:00Z') };
    const second = { a: '2026-10-06T01:00:00.000Z', z: [{ a: 1, b: 2 }] };
    expect(legacyRecoveryLiveDigest(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(legacyRecoveryLiveDigest(first)).toBe(legacyRecoveryLiveDigest(second));
  });

  it('keeps ordered evidence arrays and changed generation identities distinguishable', () => {
    expect(legacyRecoveryLiveDigest(['owner-a', 'owner-z'])).not.toBe(
      legacyRecoveryLiveDigest(['owner-z', 'owner-a']),
    );
    const first = requestFixture();
    const second = requestFixture();
    second.binding.stoppedGenerations[0].containerId = 'd'.repeat(64);
    expect(legacyRecoveryLiveDigest(parse(first))).not.toBe(
      legacyRecoveryLiveDigest(parse(second)),
    );
  });
});
