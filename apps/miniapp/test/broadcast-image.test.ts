import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMaxUploadImageTargetMimeTypes } from '../src/lib/broadcast-image';

test('prefers MAX-supported lossy output for gallery photos', () => {
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/jpeg'), [
    'image/jpeg',
    'image/png',
  ]);
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/heic'), [
    'image/jpeg',
    'image/png',
  ]);
});

test('keeps png as the first choice for images that may need transparency', () => {
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/png'), [
    'image/png',
    'image/jpeg',
  ]);
});
