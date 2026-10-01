import { NATIVE_OCR_SANDBOX_IPC_GRACE_MS } from './native-ocr-sandbox.protocol';

const NANOS_PER_MILLISECOND = 1_000_000n;
const MAX_REQUEST_BUDGET_MS = 60_000 + NATIVE_OCR_SANDBOX_IPC_GRACE_MS;
const DEADLINE_PATTERN = /^[1-9][0-9]{0,23}$/u;

export function createNativeOcrSandboxDeadline(
  totalBudgetMs: number,
  nowNs = process.hrtime.bigint(),
): bigint {
  if (
    !Number.isSafeInteger(totalBudgetMs) ||
    totalBudgetMs < 1 ||
    totalBudgetMs > MAX_REQUEST_BUDGET_MS
  ) {
    throw new Error('Native OCR sandbox request budget is invalid');
  }
  return nowNs + BigInt(totalBudgetMs) * NANOS_PER_MILLISECOND;
}

export function parseNativeOcrSandboxDeadline(
  value: unknown,
  maximumBudgetMs: number,
  nowNs = process.hrtime.bigint(),
): bigint {
  // FLAG: Both peers require a zero CLOCK_MONOTONIC time-namespace offset before
  // RPC. A deadline cannot grant more than this operation's native + IPC budget.
  if (typeof value !== 'string' || !DEADLINE_PATTERN.test(value)) {
    throw new Error('Native OCR sandbox request deadline is invalid');
  }
  const deadlineNs = BigInt(value);
  if (
    !Number.isSafeInteger(maximumBudgetMs) ||
    maximumBudgetMs < 1 ||
    maximumBudgetMs > MAX_REQUEST_BUDGET_MS ||
    deadlineNs > nowNs + BigInt(maximumBudgetMs) * NANOS_PER_MILLISECOND
  ) {
    throw new Error('Native OCR sandbox request deadline exceeds its budget');
  }
  return deadlineNs;
}

export function remainingNativeOcrSandboxTimeoutMs(
  deadlineNs: bigint,
  nowNs = process.hrtime.bigint(),
): number {
  const remainingNs = deadlineNs - nowNs;
  if (remainingNs < NANOS_PER_MILLISECOND) return 0;
  return Math.min(MAX_REQUEST_BUDGET_MS, Number(remainingNs / NANOS_PER_MILLISECOND));
}

export function nativeOcrSandboxExecutionBudgetMs(
  deadlineNs: bigint,
  nativeLimitMs: number,
  nowNs = process.hrtime.bigint(),
): number {
  return Math.max(
    0,
    Math.min(
      nativeLimitMs,
      remainingNativeOcrSandboxTimeoutMs(deadlineNs, nowNs) - NATIVE_OCR_SANDBOX_IPC_GRACE_MS,
    ),
  );
}
