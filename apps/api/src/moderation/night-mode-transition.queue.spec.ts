import {
  buildNightModeRouteVerificationJobId,
  buildNightModeTransitionJobId,
  buildNightModeTransitionJobIdPrefix,
  buildNightModeTransitionRecoveryJobId,
  NIGHT_MODE_ROUTE_VERIFICATION_KIND,
  NIGHT_MODE_STICKY_ROUTE_PROBE_KIND,
  NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  parseNightModeRouteVerification,
  parseNightModeStickyRouteProbe,
  parseNightModeTransitionRecoveryOnly,
  type NightModeRouteVerification,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';

const ROUTE_VERIFICATION: NightModeRouteVerification = {
  kind: NIGHT_MODE_ROUTE_VERIFICATION_KIND,
  version: 1,
  sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
  messageId: 'close-message-1',
  botId: 'bot-1',
  sentAt: '2026-05-30T20:00:01.000Z',
  attemptCount: 0,
  presentCount: 0,
  absentCount: 0,
};

const STICKY_ROUTE_PROBE = {
  kind: NIGHT_MODE_STICKY_ROUTE_PROBE_KIND,
  version: 1 as const,
  authorizedAt: '2026-05-30T19:59:00.000Z',
  scheduledFor: '2026-05-30T20:00:00.000Z',
  sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
  scheduleFingerprint: `sha256:${'a'.repeat(64)}`,
};

describe('night mode transition queue', () => {
  it('builds BullMQ-safe custom job ids', () => {
    const jobId = buildNightModeTransitionJobId(
      'chat-1',
      'open',
      '2026-05-31T05:00:00.000Z',
      'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    );
    const prefix = buildNightModeTransitionJobIdPrefix('chat-1');

    expect(jobId.startsWith(prefix)).toBe(true);
    expect(jobId).not.toContain(':');
    expect(prefix).not.toContain(':');
  });

  it('marks SQL/event-only close recovery explicitly on either boundary job', () => {
    const recoveryOnly = {
      kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
      version: 1 as const,
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      messageId: 'close-message-1',
      botId: 'bot-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    };
    const job: NightModeTransitionJob = {
      chatId: 'chat-1',
      transition: 'open',
      scheduledFor: '2026-05-31T05:00:00.000Z',
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      recoveryOnly,
    };

    expect(parseNightModeTransitionRecoveryOnly(job.recoveryOnly)).toEqual(recoveryOnly);
    const recoveryJobId = buildNightModeTransitionRecoveryJobId(job.chatId, recoveryOnly);
    expect(recoveryJobId).not.toBe(
      buildNightModeTransitionJobId(job.chatId, job.transition, job.scheduledFor, job.sessionKey),
    );
    expect(recoveryJobId).toBe(
      'night-mode-transition__3ba2855dd7d11593805afe04781fa9ea35302ee1__recovery__6b98a996fae0ae28869a9e768fa8f9e0de28cd833a5601da78d58beda7a8c868',
    );
  });

  it('rejects a recovery envelope whose immutable schedule does not match its session', () => {
    expect(
      parseNightModeTransitionRecoveryOnly({
        kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
        version: 1,
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        messageId: 'close-message-1',
        botId: 'bot-1',
        timezone: 'UTC',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).toBeNull();
  });

  it('builds a deterministic route-verification id from immutable send proof', () => {
    const first = buildNightModeRouteVerificationJobId('chat-1', ROUTE_VERIFICATION);
    const retriedVerification: NightModeRouteVerification = {
      ...ROUTE_VERIFICATION,
      attemptCount: 6,
      presentCount: 2,
      absentCount: 3,
    };
    const second = buildNightModeRouteVerificationJobId('chat-1', retriedVerification);

    expect(first).toBe(second);
    expect(first).toBe(
      'night-mode-transition__3ba2855dd7d11593805afe04781fa9ea35302ee1__verify__b9ce0cb5ab58dc813f8ad780c99fb2c1b083379a667ce4ed150a014a58c94103',
    );
    expect(first).not.toContain(':');
    expect(
      buildNightModeRouteVerificationJobId('chat-1', {
        ...ROUTE_VERIFICATION,
        messageId: 'close-message-2',
      }),
    ).not.toBe(first);
  });

  it('parses a canonical bounded route-verification envelope', () => {
    expect(parseNightModeRouteVerification(ROUTE_VERIFICATION)).toEqual(ROUTE_VERIFICATION);
    expect(
      parseNightModeRouteVerification({
        ...ROUTE_VERIFICATION,
        sessionKey: ` ${ROUTE_VERIFICATION.sessionKey} `,
        messageId: ' close-message-1 ',
        botId: ' bot-1 ',
      }),
    ).toEqual(ROUTE_VERIFICATION);
  });

  it.each([
    ['wrong kind', { kind: 'close_notice_event' }],
    ['wrong version', { version: 2 }],
    ['empty session', { sessionKey: ' ' }],
    ['non-canonical sentAt', { sentAt: '2026-05-30T20:00:01Z' }],
    ['invalid sentAt', { sentAt: 'not-a-date' }],
    ['negative attempt count', { attemptCount: -1 }],
    ['excess attempt count', { attemptCount: 7 }],
    ['excess present count', { presentCount: 3 }],
    ['excess absent count', { absentCount: 4 }],
    ['present count ahead of attempts', { attemptCount: 0, presentCount: 1 }],
    ['absent count ahead of attempts', { attemptCount: 1, absentCount: 2 }],
    [
      'simultaneous present and absent observations',
      { attemptCount: 2, presentCount: 1, absentCount: 1 },
    ],
  ])('rejects route verification with %s', (_label, override) => {
    expect(parseNightModeRouteVerification({ ...ROUTE_VERIFICATION, ...override })).toBeNull();
  });

  it('parses an exact future close sticky-route probe authorization', () => {
    expect(parseNightModeStickyRouteProbe(STICKY_ROUTE_PROBE)).toEqual(STICKY_ROUTE_PROBE);
  });

  it.each([
    ['wrong kind', { kind: 'current_night_close' }],
    ['wrong version', { version: 2 }],
    ['non-canonical authorization time', { authorizedAt: '2026-05-30T19:59:00Z' }],
    ['authorization at the boundary', { authorizedAt: STICKY_ROUTE_PROBE.scheduledFor }],
    ['scheduled time outside the session close', { scheduledFor: '2026-05-30T20:01:00.000Z' }],
    ['invalid session', { sessionKey: 'session-1' }],
    ['invalid fingerprint', { scheduleFingerprint: 'sha256:not-a-digest' }],
    ['unexpected field', { unexpected: true }],
  ])('rejects sticky-route probe authorization with %s', (_label, override) => {
    expect(parseNightModeStickyRouteProbe({ ...STICKY_ROUTE_PROBE, ...override })).toBeNull();
  });
});
