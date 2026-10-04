import { PhotoDecodeBudget } from './photo-decode-resource';
import { PhotoFingerprintRejectedError, PhotoFingerprintService } from './photo-fingerprint';
import {
  decodePhotoFrame,
  PHOTO_NATIVE_HEADER_BYTES,
  PHOTO_NATIVE_MAX_BYTES,
  PHOTO_NATIVE_MAX_METADATA_BYTES,
  parsePhotoRequest,
  type NativePhotoResult,
} from './native-photo-sandbox.protocol';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > PHOTO_NATIVE_HEADER_BYTES + PHOTO_NATIVE_MAX_METADATA_BYTES + PHOTO_NATIVE_MAX_BYTES)
      throw new Error('Photo worker input exceeds bounds');
    chunks.push(chunk as Buffer);
  }
  const frame = decodePhotoFrame(Buffer.concat(chunks, size));
  const request = parsePhotoRequest(frame.metadata);
  let result: NativePhotoResult;
  try {
    if (Date.now() >= request.deadlineAtMs) {
      result = { kind: 'rejected', reason: 'decode_deadline_exceeded' };
    } else {
      const service = new PhotoFingerprintService({
        canonicalOnly: true,
        maxInputBytes: request.maxInputBytes,
        maxInputPixels: request.maxInputPixels,
      });
      result = {
        kind: 'complete',
        fingerprint: await service.fingerprint(frame.payload, {
          expectedFormat: request.expectedFormat,
          albumBudget: new PhotoDecodeBudget({
            maxEncodedBytes: request.remainingEncodedBytes,
            maxPixels: request.remainingPixels,
          }),
        }),
      };
    }
  } catch (error) {
    if (!(error instanceof PhotoFingerprintRejectedError)) throw error;
    result = { kind: 'rejected', reason: error.reason };
  }
  process.stdout.write(JSON.stringify(result));
}

void main().catch(() => {
  process.exitCode = 1;
});
