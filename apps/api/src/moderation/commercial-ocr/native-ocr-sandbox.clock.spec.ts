import fs from 'node:fs';

import {
  assertNativeOcrSandboxSharedClock,
  assertNativeOcrSandboxTimeNamespaceOffsets,
} from './native-ocr-sandbox.clock';

describe('native OCR shared kernel clock proof', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts the kernel zero monotonic offset and does not use boottime for hrtime', () => {
    expect(() =>
      assertNativeOcrSandboxTimeNamespaceOffsets(
        Buffer.from('monotonic           0         0\nboottime            0         0\n'),
      ),
    ).not.toThrow();
    expect(() =>
      assertNativeOcrSandboxTimeNamespaceOffsets(Buffer.from('boottime -10 123\nmonotonic 0 0\n')),
    ).not.toThrow();
  });

  it.each([
    '',
    'monotonic 0 0\n',
    'monotonic 0 0\nmonotonic 0 0\n',
    'monotonic 1 0\nboottime 0 0\n',
    'monotonic 0 1\nboottime 0 0\n',
    'monotonic -1 0\nboottime 0 0\n',
    'monotonic 0 0\nother 0 0\n',
    'monotonic NaN 0\nboottime 0 0\n',
    'monotonic 0 1000000000\nboottime 0 0\n',
    'monotonic 0 0\nboottime 0 0\nextra\n',
    'monotonic 00 0\nboottime 0 0\n',
  ])('rejects missing, shifted or malformed offsets %p', (text) => {
    expect(() => assertNativeOcrSandboxTimeNamespaceOffsets(Buffer.from(text))).toThrow();
  });

  it('rejects oversized or non-ASCII proc contents', () => {
    expect(() => assertNativeOcrSandboxTimeNamespaceOffsets(Buffer.alloc(257, 32))).toThrow();
    expect(() => assertNativeOcrSandboxTimeNamespaceOffsets(Buffer.from([0xff]))).toThrow();
  });

  it('reads a fixed proc file through partial reads and always closes it', () => {
    const content = Buffer.from('monotonic 0 0\nboottime 0 0\n');
    const open = jest.spyOn(fs, 'openSync').mockReturnValue(42);
    const close = jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
    let cursor = 0;
    jest.spyOn(fs, 'readSync').mockImplementation((...args: unknown[]) => {
      const [, output, offset, length] = args;
      const copied = content.copy(
        output as Buffer,
        offset as number,
        cursor,
        Math.min(cursor + 7, content.byteLength),
      );
      cursor += copied;
      expect(copied).toBeLessThanOrEqual(length as number);
      return copied;
    });
    expect(() => assertNativeOcrSandboxSharedClock()).not.toThrow();
    expect(open).toHaveBeenCalledWith('/proc/self/timens_offsets', expect.any(Number));
    expect(close).toHaveBeenCalledWith(42);
  });

  it('rejects an unreadable proc file without printing its error', () => {
    jest.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('sensitive filesystem detail');
    });
    expect(() => assertNativeOcrSandboxSharedClock()).toThrow(
      'shared monotonic clock is unverified',
    );
  });

  it('caps a malicious or unexpected proc stream at 257 bytes', () => {
    jest.spyOn(fs, 'openSync').mockReturnValue(42);
    const close = jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
    const read = jest.spyOn(fs, 'readSync').mockReturnValue(257);
    expect(() => assertNativeOcrSandboxSharedClock()).toThrow(
      'shared monotonic clock is unverified',
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(42);
  });
});
