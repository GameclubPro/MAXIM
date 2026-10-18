import type { PrismaService } from '../prisma/prisma.service';
import { PublicationOccurrenceStatus } from '../prisma/prisma-client';
import {
  buildPublicationOccurrenceRollupNoopQuery,
  isUnchangedPublicationOccurrenceRollup,
  parsePublicationOccurrenceRollupNoopRollout,
  PublicationOccurrenceRollupNoopReader,
  type PublicationOccurrenceRollupNoopSnapshot,
} from './publication-occurrence-rollup-noop';
import { PublicationOccurrenceRollupNoopObserver } from './publication-occurrence-rollup-noop-observer';

const decisionTime = new Date('2026-10-18T00:00:00.000Z');
function snapshot(
  overrides: Partial<PublicationOccurrenceRollupNoopSnapshot> = {},
): PublicationOccurrenceRollupNoopSnapshot {
  return {
    status: PublicationOccurrenceStatus.IN_PROGRESS,
    scheduledAt: decisionTime,
    enrolled: true,
    hasSending: false,
    hasActivePending: true,
    ...overrides,
  };
}

function database() {
  const queryRaw: jest.MockedFunction<PrismaService['$queryRaw']> = jest.fn();
  return { $queryRaw: queryRaw } satisfies Pick<PrismaService, '$queryRaw'>;
}

describe('Publication occurrence unchanged-rollup reader', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('fails closed on an absent, malformed or unsupported independent mode', () => {
    for (const mode of ['off', 'test', '5', '25', '100'] as const) {
      expect(parsePublicationOccurrenceRollupNoopRollout(mode)).toBe(mode);
    }
    for (const mode of [undefined, null, '', 'on', '25 ', 25, true, {}]) {
      expect(parsePublicationOccurrenceRollupNoopRollout(mode)).toBe('off');
    }
  });

  it('does no SQL or diagnostic work in off mode', async () => {
    const db = database();
    const log = jest.fn();
    const reader = new PublicationOccurrenceRollupNoopReader(db, 'off', { log });
    await expect(reader.canSkip('not-read')).resolves.toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('samples the decision clock after the query await, including the exact due boundary', async () => {
    jest.useFakeTimers().setSystemTime(new Date(decisionTime.getTime() - 1));
    const db = database();
    db.$queryRaw.mockResolvedValue([snapshot({ status: PublicationOccurrenceStatus.SCHEDULED })]);
    const reader = new PublicationOccurrenceRollupNoopReader(db, '100', { log: jest.fn() });
    const result = reader.canSkip('clock-crossing');
    jest.setSystemTime(decisionTime);
    await expect(result).resolves.toBe(false);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('propagates the exact SQL error without an immediate fallback query', async () => {
    const db = database();
    const failure = new Error('database admission failed');
    db.$queryRaw.mockRejectedValue(failure);
    const reader = new PublicationOccurrenceRollupNoopReader(db, '100', {
      log: () => {
        throw new Error('diagnostic unavailable');
      },
    });
    await expect(reader.canSkip('one-probe')).rejects.toBe(failure);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('requires exactly one enrolled positive witness and never infers completion', async () => {
    const db = database();
    db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([snapshot(), snapshot()])
      .mockResolvedValueOnce([snapshot({ enrolled: false })])
      .mockResolvedValueOnce([snapshot({ hasActivePending: false })]);
    const reader = new PublicationOccurrenceRollupNoopReader(db, '100', { log: jest.fn() });
    for (let pass = 0; pass < 4; pass += 1) {
      await expect(reader.canSkip('fallback')).resolves.toBe(false);
    }
    expect(db.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('does not allow diagnostics to replace an unchanged result', async () => {
    jest.useFakeTimers().setSystemTime(decisionTime);
    const db = database();
    db.$queryRaw.mockResolvedValue([snapshot()]);
    const reader = new PublicationOccurrenceRollupNoopReader(db, '100', {
      log: () => {
        throw new Error('diagnostic unavailable');
      },
    });
    await expect(reader.canSkip('unchanged')).resolves.toBe(true);
  });

  it('limits positive decisions to the existing time-derived active status', () => {
    expect(isUnchangedPublicationOccurrenceRollup(snapshot(), decisionTime)).toBe(true);
    expect(
      isUnchangedPublicationOccurrenceRollup(
        snapshot({ hasActivePending: false, hasSending: true }),
        decisionTime,
      ),
    ).toBe(true);
    expect(
      isUnchangedPublicationOccurrenceRollup(
        snapshot({ scheduledAt: new Date(decisionTime.getTime() + 1) }),
        decisionTime,
      ),
    ).toBe(false);
    expect(
      isUnchangedPublicationOccurrenceRollup(
        snapshot({
          scheduledAt: new Date(decisionTime.getTime() + 1),
          status: PublicationOccurrenceStatus.SCHEDULED,
        }),
        decisionTime,
      ),
    ).toBe(true);
    for (const status of [
      PublicationOccurrenceStatus.AMBIGUOUS,
      PublicationOccurrenceStatus.SENT,
      PublicationOccurrenceStatus.FAILED,
      PublicationOccurrenceStatus.PARTIAL,
      PublicationOccurrenceStatus.CANCELED,
    ]) {
      expect(isUnchangedPublicationOccurrenceRollup(snapshot({ status }), decisionTime)).toBe(
        false,
      );
    }
    expect(isUnchangedPublicationOccurrenceRollup(null, decisionTime)).toBe(false);
    expect(isUnchangedPublicationOccurrenceRollup(snapshot(), new Date(NaN))).toBe(false);
    expect(
      isUnchangedPublicationOccurrenceRollup(
        snapshot({ scheduledAt: new Date(NaN) }),
        decisionTime,
      ),
    ).toBe(false);
  });

  it.each(['5', '25', '100'] as const)(
    'numeric %s mode contains no test audience reader',
    (mode) => {
      const query = buildPublicationOccurrenceRollupNoopQuery('bound-id', mode);
      expect(query.values).toContain('bound-id');
      expect(query.sql).not.toMatch(/publication_targets|target_chat_ids|rollup_recipient_page/u);
      if (mode !== '100') {
        expect(query.sql).toContain('publisher-occurrence-rollup-noop-v1:');
        expect(query.sql).not.toContain('publisher-temporal-v1:');
      }
    },
  );

  it('refuses test mode before SQL even if a database double would claim enrollment', async () => {
    const db = database();
    db.$queryRaw.mockResolvedValue([snapshot()]);
    const log = jest.fn();
    const reader = new PublicationOccurrenceRollupNoopReader(db, 'test', { log });
    await expect(reader.canSkip('not-read')).resolves.toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        rollout: 'test',
        admitted: 0,
        unchanged: 0,
        fallback: 1,
        error: 0,
      }),
    );
  });

  it.each(['test', 'off', 'invalid', undefined, 100])(
    'refuses unsupported direct query mode %j before constructing SQL',
    (mode) => {
      expect(() =>
        Reflect.apply(buildPublicationOccurrenceRollupNoopQuery, undefined, ['bound-id', mode]),
      ).toThrow('Unsupported publication occurrence rollup query mode');
    },
  );
});

describe('Publication occurrence rollup exposure observations', () => {
  afterEach(() => jest.useRealTimers());

  it('emits at most once per minute, without identifiers, and counts repeated observations', () => {
    jest.useFakeTimers().setSystemTime(decisionTime);
    const log = jest.fn();
    const observer = new PublicationOccurrenceRollupNoopObserver({ log });
    observer.record('off', false, 'fallback');
    expect(log).not.toHaveBeenCalled();
    observer.record('test', true, 'unchanged');
    observer.record('test', true, 'fallback');
    observer.record('test', false, 'error');
    expect(log).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    observer.record('test', true, 'unchanged');
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]).toEqual([
      {
        metric: 'publication_occurrence_rollup_noop_v1',
        rollout: 'test',
        windowMs: 60_000,
        observations: 3,
        admitted: 2,
        unchanged: 1,
        fallback: 1,
        error: 1,
      },
    ]);
  });

  it('also throttles failed log attempts and never throws', () => {
    jest.useFakeTimers().setSystemTime(decisionTime);
    const log = jest.fn(() => {
      throw new Error('log unavailable');
    });
    const observer = new PublicationOccurrenceRollupNoopObserver({ log });
    for (let pass = 0; pass < 10; pass += 1) {
      expect(() => observer.record('test', false, 'fallback')).not.toThrow();
    }
    expect(log).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    expect(() => observer.record('test', false, 'error')).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
