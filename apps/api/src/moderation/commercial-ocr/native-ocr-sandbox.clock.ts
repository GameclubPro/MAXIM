import { closeSync, constants, openSync, readSync } from 'node:fs';

const TIME_NAMESPACE_OFFSETS_PATH = '/proc/self/timens_offsets';
const MAX_TIME_NAMESPACE_OFFSETS_BYTES = 256;
const OFFSET_LINE =
  /^(monotonic|boottime)[\t ]+(-?(?:0|[1-9][0-9]{0,19}))[\t ]+(0|[1-9][0-9]{0,8})$/u;

export function assertNativeOcrSandboxSharedClock(): void {
  // FLAG: Absolute hrtime deadlines cross UDS only when both peers prove an unshifted kernel clock.
  // Read one fixed proc entry with an allocation bound; no environment or peer value can select it.
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      TIME_NAMESPACE_OFFSETS_PATH,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const bytes = Buffer.alloc(MAX_TIME_NAMESPACE_OFFSETS_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const received = readSync(descriptor, bytes, length, bytes.byteLength - length, null);
      if (received === 0) break;
      length += received;
    }
    assertNativeOcrSandboxTimeNamespaceOffsets(bytes.subarray(0, length));
  } catch {
    throw new Error('Native OCR sandbox shared monotonic clock is unverified');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertNativeOcrSandboxTimeNamespaceOffsets(bytes: Buffer): void {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_TIME_NAMESPACE_OFFSETS_BYTES
  ) {
    throw new Error('Native OCR sandbox time namespace offsets are invalid');
  }
  const text = bytes.toString('ascii');
  if (!bytes.equals(Buffer.from(text, 'ascii'))) {
    throw new Error('Native OCR sandbox time namespace offsets are not ASCII');
  }
  const lines = text.trim().split('\n');
  if (lines.length !== 2)
    throw new Error('Native OCR sandbox time namespace offsets are incomplete');
  const values = new Map<string, readonly [string, string]>();
  for (const line of lines) {
    const match = OFFSET_LINE.exec(line.trim());
    if (!match || values.has(match[1]!))
      throw new Error('Native OCR sandbox time namespace offsets are malformed');
    values.set(match[1]!, [match[2]!, match[3]!]);
  }
  const monotonic = values.get('monotonic');
  if (!values.has('boottime') || monotonic?.[0] !== '0' || monotonic[1] !== '0') {
    throw new Error('Native OCR sandbox monotonic clock is shifted');
  }
}
