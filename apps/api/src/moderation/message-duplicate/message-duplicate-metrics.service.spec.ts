import { Logger } from '@nestjs/common';
import {
  MESSAGE_DUPLICATE_METRIC_COUNTERS,
  MessageDuplicateMetricsService,
  type MessageDuplicateMetricCounter,
} from './message-duplicate-metrics.service';

describe('privacy-safe message duplicate diagnostics', () => {
  let service: MessageDuplicateMetricsService;
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new MessageDuplicateMetricsService();
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('aggregates attempts without per-message logging or idle timers', () => {
    expect(jest.getTimerCount()).toBe(0);
    for (let index = 0; index < 10_000; index += 1) service.record('history.matched');
    service.record('worker.retry');
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(29_999);
    expect(log).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: 'message_duplicate_diagnostics',
      schemaVersion: 1,
      windowStartedAt: expect.any(String),
      windowEndedAt: expect.any(String),
      counters: { 'history.matched': 10_000, 'worker.retry': 1 },
    });
    jest.advanceTimersByTime(300_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    service.record('history.matched');
    jest.advanceTimersByTime(30_000);
    expect(log.mock.calls[1]?.[0].counters).toEqual({ 'history.matched': 1 });
  });

  it('rejects arbitrary dimensions and never logs an unknown error verbatim', () => {
    for (let index = 0; index < 10_000; index += 1)
      service.record(`private-${index}` as MessageDuplicateMetricCounter);
    service.recordContentRejection('https://private.example/message');
    expect(jest.getTimerCount()).toBe(0);
    service.recordGuardRejection('secret free-form error');
    service.recordGuardRejection('message_duplicate_content_changed');
    service.recordContentRejection('split_album');
    jest.advanceTimersByTime(30_000);
    expect(log.mock.calls[0]?.[0].counters).toEqual({
      'guard.other_rejection': 1,
      'guard.message_duplicate_content_changed': 1,
      'content.split_album': 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|https/);
    expect(new Set(MESSAGE_DUPLICATE_METRIC_COUNTERS).size).toBe(
      MESSAGE_DUPLICATE_METRIC_COUNTERS.length,
    );
  });

  it('flushes once at shutdown and refuses new timers after destruction', () => {
    service.record('worker.completed');
    service.onModuleDestroy();
    service.onModuleDestroy();
    service.record('worker.started');
    expect(log).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not propagate logging failure into moderation or shutdown', () => {
    log.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    service.record('history.matched');
    expect(() => jest.advanceTimersByTime(30_000)).not.toThrow();
    service.record('worker.retry');
    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});
