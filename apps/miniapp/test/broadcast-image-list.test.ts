import assert from 'node:assert/strict';
import test from 'node:test';
import type { BroadcastImage } from '@maxim/contracts';
import {
  appendComposerBroadcastImages,
  normalizeComposerBroadcastImages,
} from '../src/lib/broadcast-image-list';

function image(base64: string, fileName = `${base64}.jpg`): BroadcastImage {
  return {
    base64,
    mimeType: 'image/jpeg',
    fileName,
  };
}

test('normalizes composer broadcast images by trimming and skipping duplicates', () => {
  assert.deepEqual(
    normalizeComposerBroadcastImages([
      image(' photo-1 ', ' one.jpg '),
      image('photo-1', 'copy.jpg'),
      image('', 'empty.jpg'),
      image('photo-2', 'two.jpg'),
    ]),
    [image('photo-1', 'one.jpg'), image('photo-2', 'two.jpg')],
  );
});

test('appends prepared composer images without adding duplicated or oversized payloads', () => {
  const result = appendComposerBroadcastImages([image('a')], [image('a'), image('bbbb')], {
    maxImageCount: 3,
    totalBase64Limit: 4,
  });

  assert.deepEqual(result.images, [image('a')]);
  assert.equal(result.addedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.oversizedCount, 1);
});

test('fills free slots after duplicate images are skipped', () => {
  const result = appendComposerBroadcastImages([image('a')], [image('a'), image('b')], {
    maxImageCount: 2,
  });

  assert.deepEqual(result.images, [image('a'), image('b')]);
  assert.equal(result.addedCount, 1);
  assert.equal(result.duplicateCount, 1);
});
