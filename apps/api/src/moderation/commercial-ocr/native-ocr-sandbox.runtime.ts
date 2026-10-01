export const NATIVE_OCR_SANDBOX_REQUEST_FAILURE_REASONS = [
  'capacity_exhausted',
  'request_deadline_exceeded',
  'invalid_input',
  'shutting_down',
] as const;
export type NativeOcrSandboxRequestFailureReason =
  (typeof NATIVE_OCR_SANDBOX_REQUEST_FAILURE_REASONS)[number];
export type NativeOcrSandboxOperation = 'idle' | 'preprocess' | 'recognize';
export type NativeOcrSandboxMetric = Readonly<{
  last: number | null;
  average: number | null;
  maximum: number | null;
  samples: number;
}>;
export type NativeOcrSandboxRuntimeStatus = Readonly<{
  activeOperation: NativeOcrSandboxOperation;
  queueDepth: number;
  pendingBytes: number;
  queueWaitMs: NativeOcrSandboxMetric;
  durationMs: Readonly<{ preprocess: NativeOcrSandboxMetric; recognize: NativeOcrSandboxMetric }>;
  remainingBudgetMs: number | null;
  counters: Readonly<{
    started: number;
    completed: number;
    failed: number;
    probes: number;
    rejections: Readonly<Record<NativeOcrSandboxRequestFailureReason, number>>;
  }>;
}>;

export function isNativeOcrSandboxRequestFailureReason(
  value: unknown,
): value is NativeOcrSandboxRequestFailureReason {
  return (
    typeof value === 'string' &&
    (NATIVE_OCR_SANDBOX_REQUEST_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

export function parseNativeOcrSandboxRuntimeStatus(
  value: unknown,
): NativeOcrSandboxRuntimeStatus | null {
  if (!record(value)) return null;
  const {
    activeOperation,
    queueDepth,
    pendingBytes,
    queueWaitMs,
    durationMs,
    remainingBudgetMs,
    counters,
  } = value;
  if (
    typeof activeOperation !== 'string' ||
    !['idle', 'preprocess', 'recognize'].includes(activeOperation) ||
    !integer(queueDepth, 256) ||
    !integer(pendingBytes, 256 * 64 * 1024 * 1024) ||
    !metric(queueWaitMs) ||
    !record(durationMs) ||
    !metric(durationMs.preprocess) ||
    !metric(durationMs.recognize) ||
    !(remainingBudgetMs === null || number(remainingBudgetMs, 61_000)) ||
    !record(counters) ||
    !['started', 'completed', 'failed', 'probes'].every((key) => integer(counters[key]))
  )
    return null;
  const rejections = counters.rejections;
  if (
    !record(rejections) ||
    !NATIVE_OCR_SANDBOX_REQUEST_FAILURE_REASONS.every((reason) => integer(rejections[reason]))
  )
    return null;
  // Copy only fixed scalar fields; never keep arbitrary metadata from the peer.
  return Object.freeze({
    activeOperation: activeOperation as NativeOcrSandboxOperation,
    queueDepth,
    pendingBytes,
    queueWaitMs: copyMetric(queueWaitMs),
    durationMs: Object.freeze({
      preprocess: copyMetric(durationMs.preprocess),
      recognize: copyMetric(durationMs.recognize),
    }),
    remainingBudgetMs,
    counters: Object.freeze({
      started: counters.started as number,
      completed: counters.completed as number,
      failed: counters.failed as number,
      probes: counters.probes as number,
      rejections: Object.freeze(
        Object.fromEntries(
          NATIVE_OCR_SANDBOX_REQUEST_FAILURE_REASONS.map((reason) => [reason, rejections[reason]]),
        ),
      ) as Record<NativeOcrSandboxRequestFailureReason, number>,
    }),
  }) as NativeOcrSandboxRuntimeStatus;
}

export class NativeOcrSandboxRollingMetric {
  private readonly values: number[] = [];
  private next = 0;
  record(value: number): void {
    if (!number(value)) return;
    const bounded = Math.round(value * 1_000) / 1_000;
    if (this.values.length < 512) this.values.push(bounded);
    else this.values[this.next] = bounded;
    this.next = (this.next + 1) % 512;
  }
  snapshot(): NativeOcrSandboxMetric {
    return Object.freeze({
      last: this.values.length
        ? this.values[(this.next + this.values.length - 1) % this.values.length]!
        : null,
      average: this.values.length
        ? Math.round(
            (this.values.reduce((sum, value) => sum + value, 0) / this.values.length) * 1_000,
          ) / 1_000
        : null,
      maximum: this.values.length ? Math.max(...this.values) : null,
      samples: this.values.length,
    });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return number(value, maximum) && Number.isSafeInteger(value);
}
function metric(value: unknown): value is NativeOcrSandboxMetric {
  return (
    record(value) &&
    integer(value.samples, 512) &&
    ['last', 'average', 'maximum'].every((key) => value[key] === null || number(value[key])) &&
    (value.samples === 0
      ? value.last === null && value.average === null && value.maximum === null
      : value.last !== null &&
        value.average !== null &&
        value.maximum !== null &&
        (value.last as number) <= (value.maximum as number) &&
        (value.average as number) <= (value.maximum as number))
  );
}
function copyMetric(value: NativeOcrSandboxMetric): NativeOcrSandboxMetric {
  return Object.freeze({
    last: value.last,
    average: value.average,
    maximum: value.maximum,
    samples: value.samples,
  });
}
