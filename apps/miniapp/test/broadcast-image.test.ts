import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  BROADCAST_IMAGE_OPERATION_TIMEOUT_MS,
  MAX_PREPARED_IMAGE_BYTES,
  canUploadOriginalImageToMax,
  prepareBroadcastImage,
  readBlobAsBase64,
  resolveMaxUploadImageTargetMimeTypes,
  resolveOutputFileName,
  resolvePreparedImageMaxBytes,
} from '../src/lib/broadcast-image';

function replaceGlobalProperty(
  target: object,
  key: PropertyKey,
  value: unknown,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      Reflect.deleteProperty(target, key);
    }
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

test('prefers MAX-supported lossy output for gallery photos', () => {
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/jpeg'), ['image/jpeg', 'image/png']);
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/heic'), ['image/jpeg', 'image/png']);
});

test('keeps png as the first choice for images that may need transparency', () => {
  assert.deepEqual(resolveMaxUploadImageTargetMimeTypes('image/png'), ['image/png', 'image/jpeg']);
});

test('falls back to original bytes only for MAX-supported image formats', () => {
  for (const mimeType of [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/tiff',
    'image/bmp',
    'image/heic',
  ]) {
    assert.equal(canUploadOriginalImageToMax(mimeType, 'photo.bin'), true);
  }
  assert.equal(canUploadOriginalImageToMax('image/heif', 'photo.heic'), true);
  assert.equal(canUploadOriginalImageToMax('image/heif', 'photo.heif'), false);
  assert.equal(canUploadOriginalImageToMax('image/webp', 'photo.webp'), false);
  assert.equal(canUploadOriginalImageToMax('image/avif', 'photo.avif'), false);
});

test('keeps the file name extension aligned with the prepared image MIME type', () => {
  assert.equal(resolveOutputFileName('photo.jpg', 'image/tiff'), 'photo.tiff');
  assert.equal(resolveOutputFileName('photo.jpg', 'image/bmp'), 'photo.bmp');
  assert.equal(resolveOutputFileName('photo.jpg', 'image/heic'), 'photo.heic');
  assert.equal(resolveOutputFileName('photo.jpg', 'image/heif'), 'photo.heic');
  assert.equal(resolveOutputFileName('photo.tiff', 'image/jpeg'), 'photo.jpg');
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

test('falls back to original bytes after browser decoders hang', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bytes = new Uint8Array([1, 2, 3]);
  let resolveBitmap: ((bitmap: ImageBitmap) => void) | undefined;
  let bitmapCloseCalls = 0;
  let revokeCalls = 0;
  const restoreBitmap = replaceGlobalProperty(
    globalThis,
    'createImageBitmap',
    () =>
      new Promise<ImageBitmap>((resolve) => {
        resolveBitmap = resolve;
      }),
  );
  const restoreImage = replaceGlobalProperty(
    globalThis,
    'Image',
    class HangingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      naturalHeight = 0;
      width = 0;
      height = 0;
      src = '';
    },
  );
  const restoreCreateObjectUrl = replaceGlobalProperty(URL, 'createObjectURL', () => 'blob:test');
  const restoreRevokeObjectUrl = replaceGlobalProperty(URL, 'revokeObjectURL', () => {
    revokeCalls += 1;
  });

  try {
    const preparation = prepareBroadcastImage(
      new File([bytes], 'poll-photo.jpg', { type: 'image/jpeg' }),
    );

    t.mock.timers.tick(BROADCAST_IMAGE_OPERATION_TIMEOUT_MS);
    await flushMicrotasks();
    t.mock.timers.tick(BROADCAST_IMAGE_OPERATION_TIMEOUT_MS);
    const prepared = await preparation;

    assert.equal(revokeCalls, 1);
    assert.equal(prepared.base64, Buffer.from(bytes).toString('base64'));
    assert.equal(prepared.mimeType, 'image/jpeg');
    assert.equal(prepared.fileName, 'poll-photo.jpg');
    assert.equal(prepared.width, null);
    assert.equal(prepared.height, null);
    resolveBitmap?.({
      width: 1,
      height: 1,
      close: () => {
        bitmapCloseCalls += 1;
      },
    } as ImageBitmap);
    await flushMicrotasks();
    assert.equal(bitmapCloseCalls, 1);
  } finally {
    restoreRevokeObjectUrl();
    restoreCreateObjectUrl();
    restoreImage();
    restoreBitmap();
    t.mock.timers.reset();
  }
});

test('falls back from a hanging Blob arrayBuffer read to FileReader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bytes = new Uint8Array([4, 5, 6]);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  Object.defineProperty(blob, 'arrayBuffer', {
    configurable: true,
    value: () => new Promise<ArrayBuffer>(() => undefined),
  });
  let readerAbortCalls = 0;
  const restoreFileReader = replaceGlobalProperty(
    globalThis,
    'FileReader',
    class WorkingFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL() {
        this.result = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
        queueMicrotask(() => this.onload?.());
      }

      abort() {
        readerAbortCalls += 1;
      }
    },
  );

  try {
    const reading = readBlobAsBase64(blob);
    t.mock.timers.tick(BROADCAST_IMAGE_OPERATION_TIMEOUT_MS);

    assert.equal(await reading, Buffer.from(bytes).toString('base64'));
    assert.equal(readerAbortCalls, 0);
  } finally {
    restoreFileReader();
    t.mock.timers.reset();
  }
});

test('bounds a hanging canvas encoder and falls back to original bytes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bytes = new Uint8Array([7, 8, 9]);
  let bitmapCloseCalls = 0;
  const restoreBitmap = replaceGlobalProperty(globalThis, 'createImageBitmap', async () => ({
    width: 1,
    height: 1,
    close: () => {
      bitmapCloseCalls += 1;
    },
  }));
  const restoreCanvas = replaceGlobalProperty(
    globalThis,
    'OffscreenCanvas',
    class HangingCanvas {
      private readonly context = {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        drawImage: () => undefined,
      };

      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext() {
        return this.context;
      }

      convertToBlob() {
        return new Promise<Blob>(() => undefined);
      }
    },
  );

  try {
    const preparation = prepareBroadcastImage(
      new File([bytes], 'poll-photo.jpg', { type: 'image/jpeg' }),
    );
    await flushMicrotasks();
    t.mock.timers.tick(BROADCAST_IMAGE_OPERATION_TIMEOUT_MS);
    const prepared = await preparation;

    assert.equal(prepared.base64, Buffer.from(bytes).toString('base64'));
    assert.equal(prepared.mimeType, 'image/jpeg');
    assert.equal(bitmapCloseCalls, 1);
  } finally {
    restoreCanvas();
    restoreBitmap();
    t.mock.timers.reset();
  }
});
