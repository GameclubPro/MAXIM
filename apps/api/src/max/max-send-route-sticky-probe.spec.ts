import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import {
  MAX_FUTURE_NIGHT_STICKY_ROUTE_PROBE_KIND,
  parseMaxFutureNightStickyRouteProbe,
  type MaxFutureNightStickyRouteProbe,
} from './max-send-route-sticky-probe';

const CHAT_ID = 'chat-1';
const SESSION_KEY = 'v1:Europe/Moscow:23:00:08:00:2026-07-27';
const FAILURE_BEFORE = '2026-07-27T20:00:00.000Z';
const IDEMPOTENCY_KEY = `night-mode:close:${CHAT_ID}:session:${SESSION_KEY}`;
const SCHEDULE_FINGERPRINT = buildNightModeTransitionScheduleFingerprint({
  nightModeEnabled: true,
  nightModeStartTimeMinutes: 23 * 60,
  nightModeEndTimeMinutes: 8 * 60,
  nightModeTimezone: 'Europe/Moscow',
});

function buildProbe(
  overrides: Partial<MaxFutureNightStickyRouteProbe> = {},
): MaxFutureNightStickyRouteProbe {
  return {
    kind: MAX_FUTURE_NIGHT_STICKY_ROUTE_PROBE_KIND,
    authorizedAt: '2026-07-27T19:55:00.000Z',
    failureBefore: FAILURE_BEFORE,
    sessionKey: SESSION_KEY,
    scheduleFingerprint: SCHEDULE_FINGERPRINT,
    ...overrides,
  };
}

describe('future night sticky route probe', () => {
  it('accepts only the exact session close proof after its authorized boundary', () => {
    expect(
      parseMaxFutureNightStickyRouteProbe(buildProbe(), {
        chatId: CHAT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        sourceTag: 'night_mode_transition',
        occurredAt: '2026-07-27T20:00:01.000Z',
      }),
    ).toEqual(buildProbe());
  });

  it.each([
    ['foreign source', buildProbe(), { sourceTag: 'managed_broadcast' }],
    ['foreign job', buildProbe(), { idempotencyKey: `${IDEMPOTENCY_KEY}-other` }],
    ['mismatched close boundary', buildProbe({ failureBefore: '2026-07-27T20:01:00.000Z' }), {}],
    [
      'mismatched schedule fingerprint',
      buildProbe({ scheduleFingerprint: `sha256:${'a'.repeat(64)}` }),
      {},
    ],
    [
      'authorization after the boundary',
      buildProbe({ authorizedAt: '2026-07-27T20:00:00.000Z' }),
      {},
    ],
  ])('rejects %s', (_label, probe, contextOverrides) => {
    expect(
      parseMaxFutureNightStickyRouteProbe(probe, {
        chatId: CHAT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        sourceTag: 'night_mode_transition',
        occurredAt: '2026-07-27T20:00:01.000Z',
        ...contextOverrides,
      }),
    ).toBeNull();
  });
});
