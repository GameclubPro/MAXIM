export class ResponseByteLimitExceededError extends Error {
  constructor() {
    super('Response exceeds its byte limit');
    this.name = 'ResponseByteLimitExceededError';
  }
}

export class EmptyResponseBodyError extends Error {
  constructor() {
    super('Response body is empty');
    this.name = 'EmptyResponseBodyError';
  }
}

const RESPONSE_BUFFER_BLOCK_BYTES = 64 * 1_024;

// FLAG: Content-Length is an allocation hint, never proof of actual decoded size.
// A correct uncompressed length avoids retaining all chunks beside a final video copy.
export async function readBoundedResponseBuffer(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Response byte limit must be a positive safe integer');
  }
  if (!response.body) throw new EmptyResponseBodyError();

  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let totalBytes = 0;
  let target: Buffer | null = null;
  let allocatedBytes = 0;
  let tail: Buffer | null = null;
  let tailBytes = 0;
  const blocks: Buffer[] = [];
  try {
    signal?.throwIfAborted();
    const declaredLength = readUncompressedContentLength(response.headers);
    if (declaredLength !== null && declaredLength > maxBytes) {
      throw new ResponseByteLimitExceededError();
    }
    if (declaredLength !== null && declaredLength > 0) {
      target = Buffer.allocUnsafe(declaredLength);
      allocatedBytes = declaredLength;
    }
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) {
        throw new ResponseByteLimitExceededError();
      }
      if (value.byteLength === 0) continue;
      if (target && totalBytes + value.byteLength <= target.length) {
        target.set(value, totalBytes);
      } else {
        if (target) {
          // FLAG: Reuse a false short header allocation, including its unused tail, so
          // the collector retains neither sparse prefix views nor one Buffer per chunk.
          blocks.push(target);
          tail = target;
          tailBytes = totalBytes;
          target = null;
        }
        let cursor = 0;
        while (cursor < value.byteLength) {
          if (!tail || tailBytes === tail.length) {
            // FLAG: Actual overflow was checked before copying. Collector capacity never
            // exceeds maxBytes; its object count depends on bounded blocks, not the stream.
            tail = Buffer.allocUnsafe(
              Math.min(RESPONSE_BUFFER_BLOCK_BYTES, maxBytes - allocatedBytes),
            );
            allocatedBytes += tail.length;
            blocks.push(tail);
            tailBytes = 0;
          }
          const copiedBytes = Math.min(value.byteLength - cursor, tail.length - tailBytes);
          tail.set(value.subarray(cursor, cursor + copiedBytes), tailBytes);
          cursor += copiedBytes;
          tailBytes += copiedBytes;
        }
      }
      totalBytes += value.byteLength;
    }
    if (totalBytes === 0) throw new EmptyResponseBodyError();
    if (target) {
      // FLAG: Do not retain an oversized allocation from a false long Content-Length.
      return totalBytes === target.length ? target : Buffer.from(target.subarray(0, totalBytes));
    }
    if (blocks.length === 1) {
      return tailBytes === blocks[0]!.length
        ? blocks[0]!
        : Buffer.from(blocks[0]!.subarray(0, tailBytes));
    }
    return Buffer.concat(blocks, totalBytes);
  } catch (error: unknown) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function readUncompressedContentLength(headers: Headers): number | null {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return null;
  const raw = headers.get('content-length')?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}
