import {
  createNativeOcrSandboxDeadline,
  nativeOcrSandboxExecutionBudgetMs,
  parseNativeOcrSandboxDeadline,
  remainingNativeOcrSandboxTimeoutMs,
} from './native-ocr-sandbox.deadline';
import { NATIVE_OCR_SANDBOX_IPC_GRACE_MS } from './native-ocr-sandbox.protocol';

describe('native OCR shared kernel monotonic deadline', () => {
  const now = 1_234_000_000_000n;
  const ms = 1_000_000n;
  it('reserves completion once while retaining the full configured native limit', () => {
    const deadline = createNativeOcrSandboxDeadline(10_000 + NATIVE_OCR_SANDBOX_IPC_GRACE_MS, now);
    expect(parseNativeOcrSandboxDeadline(deadline.toString(), 11_000, now)).toBe(deadline);
    expect(nativeOcrSandboxExecutionBudgetMs(deadline, 10_000, now)).toBe(10_000);
    expect(nativeOcrSandboxExecutionBudgetMs(deadline, 10_000, now + 500n * ms)).toBe(9_500);
    expect(remainingNativeOcrSandboxTimeoutMs(deadline, now + 11_000n * ms)).toBe(0);
  });
  it('never resets expired waiting work and retains IPC time for an explicit rejection', () => {
    const deadline = createNativeOcrSandboxDeadline(1_100, now);
    expect(nativeOcrSandboxExecutionBudgetMs(deadline, 100, now + 100n * ms)).toBe(0);
    expect(remainingNativeOcrSandboxTimeoutMs(deadline, now + 100n * ms)).toBe(1_000);
    expect(parseNativeOcrSandboxDeadline(deadline.toString(), 1_100, now + 2_000n * ms)).toBe(
      deadline,
    );
  });
  it.each([null, 123, '', '0', '-1', '1.1', '1e9', '01', '1'.repeat(25)])(
    'rejects an unbounded or noncanonical deadline %p',
    (value) => {
      expect(() => parseNativeOcrSandboxDeadline(value, 11_000, now)).toThrow('deadline');
    },
  );
  it('rejects a peer deadline beyond the operation limit and invalid total budgets', () => {
    expect(() =>
      parseNativeOcrSandboxDeadline((now + 11_001n * ms).toString(), 11_000, now),
    ).toThrow('exceeds');
    for (const budget of [0, -1, 1.5, Infinity, 61_001]) {
      expect(() => createNativeOcrSandboxDeadline(budget, now)).toThrow('budget');
    }
  });
});
