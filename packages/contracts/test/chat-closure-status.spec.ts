import { describe, expect, it } from 'vitest';
import {
  chatClosureStatusSchema,
  nightModeNoticeDiagnosticsSchema,
  type ChatClosureStatus,
  type NightModeNoticeDiagnostics,
} from '../src/settings';

const legacy: ChatClosureStatus = {
  observedAt: '2026-10-14T12:00:00.000Z',
  scheduleEnabled: true,
  restriction: 'open',
  timezone: 'Europe/Moscow',
  opensAt: null,
  deleteRoute: 'available',
  notice: 'not_expected',
  recovery: 'idle',
};

describe('additive night notice diagnostics contract', () => {
  it('accepts older closure payloads without inserting invented history', () => {
    expect(chatClosureStatusSchema.parse(legacy)).toEqual(legacy);
  });
  it('keeps a past receipt independent from current enabling and access', () => {
    const notices: NightModeNoticeDiagnostics = {
      expectationBasis: 'current_schedule',
      evidenceScope: 'exact_send_ledger',
      boundary: 'daily',
      sendRouteNow: 'unavailable',
      close: { enabledNow: false, latest: null },
      open: {
        enabledNow: false,
        latest: {
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-10-13',
          scheduledFor: '2026-10-14T05:00:00.000Z',
          catchUp: { state: 'expired', endsAt: '2026-10-14T07:00:00.000Z' },
          scheduling: 'not_recorded',
          delivery: {
            outcome: 'sent',
            reason: 'successful_receipt',
            sentAt: '2026-10-14T05:00:01.000Z',
          },
        },
      },
      recovery: { scope: 'latest_occurrences', observation: 'partial', obligations: [] },
    };
    expect(chatClosureStatusSchema.parse({ ...legacy, notices, nextTransitionAt: null })).toEqual({
      ...legacy,
      notices,
      nextTransitionAt: null,
    });
    expect(
      nightModeNoticeDiagnosticsSchema.safeParse({
        ...notices,
        expectationBasis: 'historically_enabled',
      }).success,
    ).toBe(false);
  });
  it('represents continuous saved schedules without fictitious boundaries', () => {
    const notices: NightModeNoticeDiagnostics = {
      expectationBasis: 'current_schedule',
      evidenceScope: 'exact_send_ledger',
      boundary: 'continuous',
      sendRouteNow: 'unknown',
      close: { enabledNow: false, latest: null },
      open: { enabledNow: false, latest: null },
      recovery: { scope: 'latest_occurrences', observation: 'complete', obligations: [] },
    };
    expect(chatClosureStatusSchema.parse({ ...legacy, notices }).notices?.boundary).toBe(
      'continuous',
    );
    expect(
      chatClosureStatusSchema.safeParse({ ...legacy, nextTransitionAt: 'not-a-date' }).success,
    ).toBe(false);
  });
});
