import {
  MessageRetentionAdmissionService,
  type RetentionAdmissionStatus,
} from './message-retention-admission.service';
import { buildRetentionPriorityQueueDescriptors } from '../max/retention-priority-admission';

const atMs = Date.UTC(2026, 9, 21, 12);
function allowedStatus(): RetentionAdmissionStatus {
  return {
    version: '1',
    observedAtMs: atMs,
    sampleStartedAtMs: atMs,
    allowed: true,
    reason: 'allowed',
    retryAfterMs: 1_000,
    window: {
      coverage: 1,
      complete: true,
      coveredMs: 60_000,
      samples: 61,
      arrivalsPerMinute: 60,
      httpPerMinute: 120,
    },
    quietSinceMs: atMs - 60_000,
    healthySinceMs: atMs - 60_000,
    queues: { ready: 0, active: 0, dueDelayed: 0 },
    resources: {
      available: true,
      cpuRatio: 0.1,
      loadRatio: 0.1,
      memoryRatio: 0.1,
      ioWaitRatio: 0.01,
    },
  };
}

describe('retention admission compact status and queue coverage', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(atMs));
  afterEach(() => jest.restoreAllMocks());

  function reader(raw: string | null) {
    const service = Object.create(
      MessageRetentionAdmissionService.prototype,
    ) as MessageRetentionAdmissionService;
    const get = jest.fn().mockResolvedValue(raw);
    Object.assign(service, { redis: { status: 'ready', get } });
    return { service, get };
  }

  it('reads only the fixed latest status and fails closed without a fresh collector', async () => {
    const { service, get } = reader(JSON.stringify(allowedStatus()));
    await expect(service.decide()).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
      retryAfterMs: 1_000,
    });
    expect(get).toHaveBeenCalledTimes(1);
    jest.mocked(Date.now).mockReturnValue(atMs + 2_001);
    await expect(service.decide()).resolves.toEqual({
      allowed: false,
      reason: 'collector_unavailable',
      retryAfterMs: 1_000,
    });
  });

  it('does not turn missing, corrupt, future, partial or inconsistent status into permission', async () => {
    for (const raw of [
      null,
      'broken',
      JSON.stringify({ ...allowedStatus(), observedAtMs: atMs + 1 }),
      JSON.stringify({ ...allowedStatus(), window: null }),
      JSON.stringify({ ...allowedStatus(), queues: { ready: 1, active: 0, dueDelayed: 0 } }),
      JSON.stringify({ ...allowedStatus(), healthySinceMs: atMs - 59_999 }),
      JSON.stringify({ ...allowedStatus(), resources: { available: false } }),
    ]) {
      expect((await reader(raw).service.decide()).allowed).toBe(false);
    }
  });

  it('requires every existing queue registration with the exact production prefix', () => {
    const service = Object.create(
      MessageRetentionAdmissionService.prototype,
    ) as MessageRetentionAdmissionService;
    const descriptors = buildRetentionPriorityQueueDescriptors();
    Object.assign(service, { descriptors, moduleRef: { get: jest.fn(() => undefined) } });
    const coverage = service as unknown as { assertQueueCoverage(): void };
    expect(() => coverage.assertQueueCoverage()).toThrow('Missing retention priority queue');
    Object.assign(service, {
      moduleRef: { get: jest.fn(() => ({ toKey: () => 'another-prefix' })) },
    });
    expect(() => coverage.assertQueueCoverage()).toThrow('Missing retention priority queue');
  });
});
