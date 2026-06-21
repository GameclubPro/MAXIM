import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canUseOriginalBroadcastImage,
  MAX_PREPARED_IMAGE_BYTES,
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

test('uses the original image bytes for MAX-supported mobile photo formats', () => {
  assert.equal(canUseOriginalBroadcastImage('image/jpeg', 1_000_000), true);
  assert.equal(canUseOriginalBroadcastImage('image/png', 1_000_000), true);
  assert.equal(canUseOriginalBroadcastImage('image/heic', 1_000_000), true);
  assert.equal(canUseOriginalBroadcastImage('image/webp', 1_000_000), false);
  assert.equal(canUseOriginalBroadcastImage('image/jpeg', MAX_PREPARED_IMAGE_BYTES + 1), false);
});
