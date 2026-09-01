import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedBroadcastImage } from '../src/lib/broadcast-image';
import { prepareComposerImageFiles } from '../src/lib/broadcast-image-preparation';

function prepared(file: File): PreparedBroadcastImage {
  return {
    base64: `payload-${file.name}`,
    mimeType: 'image/jpeg',
    fileName: file.name,
    width: 1200,
    height: 800,
  };
}

test('keeps successfully prepared photos when another selected file fails', async () => {
  const files = [
    new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
    new File(['broken'], 'broken.jpg', { type: 'image/jpeg' }),
    new File(['three'], 'three.jpg', { type: 'image/jpeg' }),
  ];
  const readySnapshots: string[][] = [];
  const progress: number[] = [];
  const result = await prepareComposerImageFiles({
    files,
    currentImages: [],
    signal: new AbortController().signal,
    prepareImage: async (file) => {
      if (file.name === 'broken.jpg') {
        throw new Error('Повреждённый файл.');
      }
      return prepared(file);
    },
    onImagesReady: (images) => readySnapshots.push(images.map((image) => image.fileName)),
    onProgress: ({ done }) => progress.push(done),
  });

  assert.equal(result.aborted, false);
  assert.equal(result.addedCount, 2);
  assert.deepEqual(
    result.images.map((image) => image.fileName),
    ['one.jpg', 'three.jpg'],
  );
  assert.deepEqual(result.failedMessages, ['Повреждённый файл.']);
  assert.deepEqual(readySnapshots, [['one.jpg'], ['one.jpg', 'three.jpg']]);
  assert.deepEqual(progress, [1, 2, 3]);
});

test('aborting an in-flight preparation prevents every late mutation callback', async () => {
  const controller = new AbortController();
  let resolvePreparation: ((value: PreparedBroadcastImage) => void) | null = null;
  const pendingPreparation = new Promise<PreparedBroadcastImage>((resolve) => {
    resolvePreparation = resolve;
  });
  const readySnapshots: string[][] = [];
  const progress: number[] = [];
  const file = new File(['late'], 'late.jpg', { type: 'image/jpeg' });
  const resultPromise = prepareComposerImageFiles({
    files: [file],
    currentImages: [],
    signal: controller.signal,
    prepareImage: () => pendingPreparation,
    onImagesReady: (images) => readySnapshots.push(images.map((image) => image.fileName)),
    onProgress: ({ done }) => progress.push(done),
  });

  controller.abort();
  resolvePreparation?.(prepared(file));
  const result = await resultPromise;

  assert.equal(result.aborted, true);
  assert.equal(result.addedCount, 0);
  assert.deepEqual(result.images, []);
  assert.deepEqual(readySnapshots, []);
  assert.deepEqual(progress, []);
});

test('skips a duplicate without preventing a later unique photo from being added', async () => {
  const files = [
    new File(['copy'], 'copy.jpg', { type: 'image/jpeg' }),
    new File(['new'], 'new.jpg', { type: 'image/jpeg' }),
  ];
  const result = await prepareComposerImageFiles({
    files,
    currentImages: [{ base64: 'same', mimeType: 'image/jpeg', fileName: 'original.jpg' }],
    maxImageCount: 3,
    signal: new AbortController().signal,
    prepareImage: async (file) =>
      file.name === 'copy.jpg'
        ? { ...prepared(file), base64: 'same' }
        : { ...prepared(file), base64: 'new' },
  });

  assert.equal(result.duplicateCount, 1);
  assert.equal(result.addedCount, 1);
  assert.deepEqual(
    result.images.map((image) => image.base64),
    ['same', 'new'],
  );
});
