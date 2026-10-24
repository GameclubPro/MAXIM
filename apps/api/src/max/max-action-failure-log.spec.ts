import { MaxActionFailureLog, type MaxActionFailureLogEntry } from './max-action-failure-log';

const entry: MaxActionFailureLogEntry = {
  botId: 'bot-a',
  statusCode: 404,
  errorCode: 'not.found',
  limitScope: null,
  trafficClass: 'critical',
  lane: 'critical',
  sourceTag: 'moderation_sanction',
  failureOrigin: 'unlinked',
  isCritical: false,
  requestAssociation: 'unlinked',
  method: 'unknown',
  endpointKind: 'unknown',
};

describe('bounded MAX action failure summaries', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps every failure by cause after the first warning and flushes an otherwise quiet window', () => {
    const emit = jest.fn();
    const log = new MaxActionFailureLog(emit);
    expect(log.record(entry)).toBe(true);
    for (let i = 0; i < 54; i++) expect(log.record(entry)).toBe(false);
    expect(log.record({ ...entry, statusCode: null, errorCode: 'econnaborted' })).toBe(false);
    expect(log.record({ ...entry, botId: 'bot-b' })).toBe(true);
    jest.advanceTimersByTime(30_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ totalFailures: 57, unclassifiedFailures: 0 });
    expect(emit.mock.calls[0][0].groups.map((g: { count: number }) => g.count)).toEqual([55, 1, 1]);
    expect(log.record(entry)).toBe(true);
    log.close();
    expect(emit.mock.calls[1][0].totalFailures).toBe(1);
    jest.advanceTimersByTime(60_000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(log.record(entry)).toBe(false);
  });

  it('bounds memory and reports overflow instead of losing counts or inventing a cause', () => {
    const emit = jest.fn();
    const log = new MaxActionFailureLog(emit);
    for (let i = 0; i < 200; i++) log.record({ ...entry, errorCode: `error_${i}` });
    log.record(entry);
    log.close();
    const summary = emit.mock.calls[0][0];
    expect(summary.groups).toHaveLength(128);
    expect(summary.totalFailures).toBe(201);
    expect(summary.unclassifiedFailures).toBe(73);
  });

  it('retains each bot warning cooldown across summary boundaries', () => {
    const log = new MaxActionFailureLog(jest.fn());
    expect(log.record(entry)).toBe(true);
    jest.advanceTimersByTime(29_000);
    expect(log.record({ ...entry, botId: 'late-bot' })).toBe(true);
    jest.advanceTimersByTime(1_000);
    expect(log.record({ ...entry, botId: 'late-bot' })).toBe(false);
    jest.advanceTimersByTime(29_000);
    expect(log.record({ ...entry, botId: 'late-bot' })).toBe(true);
    log.close();
  });

  it('excludes background, raw errors and arbitrary fields while retaining exact HTTP association', () => {
    const emit = jest.fn();
    const log = new MaxActionFailureLog(emit);
    log.record({ ...entry, lane: 'background' });
    log.record({ ...entry, trafficClass: 'background' });
    log.record(
      Object.assign(
        {
          ...entry,
          requestAssociation: 'linked' as const,
          method: 'delete' as const,
          endpointKind: 'messages' as const,
          phase: 'adapter_rejection' as const,
          receivedStatusCode: 404,
        },
        { error: 'PRIVATE_PAYLOAD', url: 'PRIVATE_URL' },
      ),
    );
    log.close();
    expect(emit.mock.calls[0][0]).toMatchObject({
      totalFailures: 1,
      groups: [
        { requestAssociation: 'linked', phase: 'adapter_rejection', receivedStatusCode: 404 },
      ],
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE');
  });
});
