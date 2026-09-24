import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  BROADCAST_IMAGE_OPERATION_TIMEOUT_MS,
  BROADCAST_IMAGE_PREPARATION_TIMEOUT_MS,
  ImagePreparationError,
  MAX_PREPARED_IMAGE_BYTES,
  canUploadOriginalImageToMax,
  prepareBroadcastImage,
  readBlobAsBase64,
  resolveMaxUploadImageTargetMimeTypes,
  resolveOutputFileName,
  resolvePreparedImageMaxBytes,
} from '../src/lib/broadcast-image';

function replaceGlobalProperty(target: object, key: PropertyKey, value: unknown): () => void {
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
  for (let index = 0; index < 30; index += 1) {
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
  assert.equal(resolveOutputFileName('x'.repeat(200) + '.png', 'image/jpeg').length, 128);
  assert.ok(resolveOutputFileName('x'.repeat(200), 'image/tiff').endsWith('.tiff'));
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

    await flushMicrotasks();
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
        fillRect: () => undefined,
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

test('reports empty and oversized sources before invoking any browser decoder', async () => {
  await assert.rejects(prepareBroadcastImage(new File([], 'empty.jpg')), { code: 'empty' });
  await assert.rejects(
    prepareBroadcastImage(new File([new Uint8Array(6_000_001)], 'large.jpg'), {
      maxSourceBytes: 6_000_000,
    }),
    { code: 'source-size' },
  );
  await assert.rejects(
    prepareBroadcastImage(new File(['text'], 'readme.txt', { type: 'text/plain' })),
    { code: 'format' },
  );
});

test('recognizes nameless and misleading native photos before original-byte fallback', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  for (const type of ['', 'application/octet-stream', 'image/x-png']) {
    const result = await prepareBroadcastImage(new File([bytes], 'native-id', { type }));
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.fileName, 'native-id.jpg');
    assert.equal(result.base64, Buffer.from(bytes).toString('base64'));
  }
});

test('distinguishes unsupported browser decoding from output and source size limits', async () => {
  await assert.rejects(
    prepareBroadcastImage(new File(['avif'], 'photo.avif', { type: 'image/avif' })),
    { code: 'decode' },
  );
  await assert.rejects(
    prepareBroadcastImage(new File(['heif'], 'photo.heif', { type: 'image/heif' })),
    (error: unknown) =>
      error instanceof ImagePreparationError &&
      error.code === 'decode' &&
      error.message.includes('HEIC/HEIF'),
  );
});

test('reports a readable error when both native file readers fail', async () => {
  const blob = new Blob(['data']);
  Object.defineProperty(blob, 'arrayBuffer', {
    value: () => Promise.reject(new Error('native read failure')),
  });
  await assert.rejects(
    readBlobAsBase64(blob),
    (error: unknown) =>
      error instanceof ImagePreparationError &&
      error.code === 'read' &&
      !error.message.includes('native'),
  );
});

test('aborting a legacy file read aborts the reader and detaches its handlers', async () => {
  const controller = new AbortController();
  const readers: Array<{ onload: unknown; onerror: unknown; onabort: unknown }> = [];
  let aborts = 0;
  const blob = new Blob(['data']);
  Object.defineProperty(blob, 'arrayBuffer', { value: undefined });
  const restore = replaceGlobalProperty(
    globalThis,
    'FileReader',
    class {
      onload = null;
      onerror = null;
      onabort = null;
      constructor() {
        readers.push(this);
      }
      readAsDataURL() {}
      abort() {
        aborts += 1;
      }
    },
  );
  try {
    const pending = readBlobAsBase64(blob, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(aborts, 1);
    assert.equal(readers[0]?.onload, null);
    assert.equal(readers[0]?.onerror, null);
    assert.equal(readers[0]?.onabort, null);
  } finally {
    restore();
  }
});

test('cancellation rejects promptly and closes a late bitmap without starting another decoder', async () => {
  const controller = new AbortController();
  let resolveBitmap: ((value: ImageBitmap) => void) | undefined;
  let closeCalls = 0;
  const restore = replaceGlobalProperty(
    globalThis,
    'createImageBitmap',
    () =>
      new Promise<ImageBitmap>((resolve) => {
        resolveBitmap = resolve;
      }),
  );
  try {
    const pending = prepareBroadcastImage(new File(['webp'], 'photo.webp'), {
      signal: controller.signal,
    });
    await flushMicrotasks();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    resolveBitmap?.({
      width: 200,
      height: 100,
      close: () => {
        closeCalls += 1;
      },
    } as ImageBitmap);
    await flushMicrotasks();
    assert.equal(closeCalls, 1);
  } finally {
    restore();
  }
});

test('supports WebViews without AbortSignal.throwIfAborted', async () => {
  const restore = replaceGlobalProperty(AbortSignal.prototype, 'throwIfAborted', undefined);
  try {
    const result = await prepareBroadcastImage(
      new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }),
    );
    assert.equal(result.mimeType, 'image/jpeg');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      prepareBroadcastImage(new File(['jpeg'], 'photo.jpg'), { signal: controller.signal }),
      { name: 'AbortError' },
    );
  } finally {
    restore();
  }
});

test('enforces one total deadline even when a source read is stuck', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = new File(['photo'], 'photo.jpg');
  Object.defineProperty(file, 'slice', {
    value: () => ({ arrayBuffer: () => new Promise(() => undefined) }),
  });
  const pending = prepareBroadcastImage(file);
  const assertion = assert.rejects(pending, { code: 'timeout' });
  t.mock.timers.tick(BROADCAST_IMAGE_PREPARATION_TIMEOUT_MS);
  await assertion;
  t.mock.timers.reset();
});

test('retries a broken OffscreenCanvas through DOM canvas and releases both canvases', async () => {
  const canvases: Array<{ width: number; height: number }> = [];
  let bitmapCloseCalls = 0;
  const context = { drawImage() {}, fillRect() {} };
  const restoreBitmap = replaceGlobalProperty(globalThis, 'createImageBitmap', async () => ({
    width: 400,
    height: 200,
    close() {
      bitmapCloseCalls += 1;
    },
  }));
  const restoreOffscreen = replaceGlobalProperty(
    globalThis,
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number,
      ) {
        canvases.push(this);
      }
      getContext() {
        return context;
      }
      async convertToBlob() {
        throw new Error('broken native encoder');
      }
    },
  );
  const restoreDocument = replaceGlobalProperty(globalThis, 'document', {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob: (callback: (blob: Blob) => void) =>
          callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  try {
    const result = await prepareBroadcastImage(new File(['webp'], 'photo.webp'));
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.width, 400);
    assert.equal(result.height, 200);
    assert.equal(canvases.length, 2);
    assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
    assert.equal(bitmapCloseCalls, 1);
  } finally {
    restoreDocument();
    restoreOffscreen();
    restoreBitmap();
  }
});

test('does not encode identical dimensions repeatedly when the image cannot fit the budget', async () => {
  let encodes = 0;
  const restoreBitmap = replaceGlobalProperty(globalThis, 'createImageBitmap', async () => ({
    width: 100,
    height: 100,
    close() {},
  }));
  const restoreCanvas = replaceGlobalProperty(
    globalThis,
    'OffscreenCanvas',
    class {
      getContext() {
        return { drawImage() {}, fillRect() {} };
      }
      async convertToBlob({ type }: { type: string }) {
        encodes += 1;
        return new Blob([new Uint8Array(100_000)], { type });
      }
    },
  );
  try {
    await assert.rejects(
      prepareBroadcastImage(new File(['webp'], 'photo.webp'), { maxBytes: 96_000 }),
      { code: 'output-size' },
    );
    assert.equal(encodes, 7);
  } finally {
    restoreCanvas();
    restoreBitmap();
  }
});
