import {
  NativeOcrSandboxRollingMetric,
  parseNativeOcrSandboxRuntimeStatus,
} from './native-ocr-sandbox.runtime';

describe('bounded native sandbox runtime measurements', () => {
  it('retains only the last 512 numeric observations without turning absence into zero', () => {
    const metric = new NativeOcrSandboxRollingMetric();
    expect(metric.snapshot()).toEqual({ last: null, average: null, maximum: null, samples: 0 });
    metric.record(NaN);
    for (let i = 0; i < 1_024; i += 1) metric.record(i);
    expect(metric.snapshot()).toEqual({
      last: 1_023,
      average: 767.5,
      maximum: 1_023,
      samples: 512,
    });
  });
  it('copies only fixed runtime scalars and rejects fabricated queue or timing state', () => {
    const empty = new NativeOcrSandboxRollingMetric().snapshot();
    const status = {
      activeOperation: 'idle',
      queueDepth: 0,
      pendingBytes: 0,
      queueWaitMs: empty,
      durationMs: { preprocess: empty, recognize: empty },
      remainingBudgetMs: null,
      counters: {
        started: 0,
        completed: 0,
        failed: 0,
        probes: 1,
        rejections: {
          capacity_exhausted: 0,
          request_deadline_exceeded: 0,
          invalid_input: 0,
          shutting_down: 0,
        },
      },
    };
    expect(parseNativeOcrSandboxRuntimeStatus({ ...status, unexpected: 'sensitive' })).toEqual(
      status,
    );
    expect(parseNativeOcrSandboxRuntimeStatus(undefined)).toBeNull();
    expect(parseNativeOcrSandboxRuntimeStatus({ ...status, queueDepth: 257 })).toBeNull();
    expect(parseNativeOcrSandboxRuntimeStatus({ ...status, activeOperation: 'probe' })).toBeNull();
    expect(
      parseNativeOcrSandboxRuntimeStatus({ ...status, queueWaitMs: { ...empty, last: 0 } }),
    ).toBeNull();
  });
});
