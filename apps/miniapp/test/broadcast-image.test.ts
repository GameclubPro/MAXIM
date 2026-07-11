import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  MAX_PREPARED_IMAGE_BYTES,
  readBlobAsBase64,
  resolveMaxUploadImageTargetMimeTypes,
  resolvePreparedImageMaxBytes,
} from '../src/lib/broadcast-image';

test('prefers MAX-supported lossy output for gallery photos', () => {
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/jpeg'), ['image/jpeg', 'image/png']);
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/heic'), ['image/jpeg', 'image/png']);
});

test('keeps png as the first choice for images that may need transparency', () => {
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/png'), ['image/png', 'image/jpeg']);
});

test('allows prepared images above the old 3 MB ceiling', () => {
  assert.equal(MAX_PREPARED_IMAGE_BYTES, 6_000_000);
  assert.equal(resolvePreparedImageMaxBytes({ maxBytes: 5_500_000 }), 5_500_000);
  assert.equal(resolvePreparedImageMaxBytes({ maxBytes: 20_000_000 }), MAX_PREPARED_IMAGE_BYTES);
});

test('reads photo blobs through ArrayBuffer before FileReader', async () => {
  const bytes = new Uint8Array(12_290);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }

  const fileReaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class BrokenFileReader {
      constructor() {
        throw new Error('FileReader must not be used when Blob.arrayBuffer is available.');
      }
    },
  });

  try {
    const base64 = await readBlobAsBase64(new Blob([bytes]));

    assert.equal(base64, Buffer.from(bytes).toString('base64'));
  } finally {
    if (fileReaderDescriptor) {
      Object.defineProperty(globalThis, 'FileReader', fileReaderDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'FileReader');
    }
  }
});
