import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PhotoFingerprintService } from './photo-fingerprint';
import { NativePhotoSandboxClient } from './native-photo-sandbox.client';
import { startNativePhotoSandbox } from './native-photo-sandbox.server';
import { runNativePhotoWorker } from './native-photo-runner';
import {
  decodePhotoFrame,
  encodePhotoFrame,
  PHOTO_NATIVE_MAX_BYTES,
  PHOTO_NATIVE_MAX_PIXELS,
  photoFrameLength,
  type NativePhotoRequest,
  type NativePhotoResult,
} from './native-photo-sandbox.protocol';

const request = (): NativePhotoRequest => ({
  operation: 'fingerprint',
  deadlineAtMs: Date.now() + 10_000,
  maxInputBytes: PHOTO_NATIVE_MAX_BYTES,
  maxInputPixels: PHOTO_NATIVE_MAX_PIXELS,
  remainingEncodedBytes: PHOTO_NATIVE_MAX_BYTES * 2,
  remainingPixels: PHOTO_NATIVE_MAX_PIXELS * 2,
});
const workerOptions = {
  workerPath: join(__dirname, 'native-photo-worker.ts'),
  execArgv: ['--import', require.resolve('tsx')],
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('native photo proof transport', () => {
  it('rejects overlarge declarations before allocating payloads and ignores no trailing data', () => {
    const valid = encodePhotoFrame({ operation: 'probe' });
    expect(decodePhotoFrame(valid, 0)).toEqual({
      metadata: { operation: 'probe' },
      payload: Buffer.alloc(0),
    });
    const oversize = Buffer.from(valid);
    oversize.writeUInt32BE(PHOTO_NATIVE_MAX_BYTES + 1, 8);
    expect(() => photoFrameLength(oversize)).toThrow('bounds');
    expect(() => decodePhotoFrame(Buffer.concat([valid, Buffer.from('extra')]))).toThrow('length');
  });

  it('rejects a sandbox with an external network before opening its socket', async () => {
    await expect(
      startNativePhotoSandbox(
        {},
        { networkInterfaces: () => ({ eth0: [{ internal: false } as never] }) },
      ),
    ).rejects.toThrow('network-isolated');
  });
});

describe('native photo process lifecycle', () => {
  jest.setTimeout(20_000);

  it('preserves exact native raster hashes across format, alpha, orientation and dimensions', async () => {
    const source = sharp({
      create: {
        width: 19,
        height: 11,
        channels: 4,
        background: { r: 12, g: 80, b: 220, alpha: 0.35 },
      },
    });
    const fixtures = [
      await source.clone().png().toBuffer(),
      await source.clone().flatten().jpeg().toBuffer(),
      await source.clone().webp({ lossless: true }).toBuffer(),
      await source.clone().tiff().toBuffer(),
      await source.clone().avif().toBuffer(),
      await source.clone().withMetadata({ orientation: 6 }).png().toBuffer(),
      await source.clone().resize(11, 19).png().toBuffer(),
    ];
    const local = new PhotoFingerprintService({ canonicalOnly: true });
    for (const bytes of fixtures) {
      const expected = await local.fingerprint(bytes);
      const actual = await runNativePhotoWorker(
        request(),
        bytes,
        new AbortController().signal,
        workerOptions,
      );
      expect(actual).toEqual({ kind: 'complete', fingerprint: expected });
    }
  });

  it('kills and reaps a hanging native worker before a subsequent normal decode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-worker-'));
    try {
      const marker = join(directory, 'pid');
      const worker = join(directory, 'hang.cjs');
      await writeFile(
        worker,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`,
      );
      const actual = await runNativePhotoWorker(
        { ...request(), deadlineAtMs: Date.now() + 700 },
        Buffer.from('image'),
        new AbortController().signal,
        { workerPath: worker },
      );
      expect(actual).toEqual({ kind: 'rejected', reason: 'decode_deadline_exceeded' });
      expect(alive(Number(await readFile(marker, 'utf8')))).toBe(false);
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
        .png()
        .toBuffer();
      expect(
        await runNativePhotoWorker(request(), bytes, new AbortController().signal, workerOptions),
      ).toMatchObject({ kind: 'complete' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not inherit API credentials or NODE_OPTIONS into workers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-worker-'));
    process.env.MAXIM_PHOTO_TEST_SECRET = 'must-not-cross';
    try {
      const worker = join(directory, 'environment.cjs');
      await writeFile(
        worker,
        `process.stdin.resume(); process.stdin.on('end', () => { if (process.env.MAXIM_PHOTO_TEST_SECRET || process.env.NODE_OPTIONS) process.exit(9); process.stdout.write(JSON.stringify({kind:'rejected',reason:'unsupported_image'})); });`,
      );
      expect(
        await runNativePhotoWorker(request(), Buffer.from('image'), new AbortController().signal, {
          workerPath: worker,
        }),
      ).toEqual({ kind: 'rejected', reason: 'unsupported_image' });
    } finally {
      delete process.env.MAXIM_PHOTO_TEST_SECRET;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects stdout expansion and reaps the offending process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-worker-'));
    try {
      const marker = join(directory, 'pid');
      const worker = join(directory, 'large.cjs');
      await writeFile(
        worker,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdin.resume(); process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000);`,
      );
      expect(
        await runNativePhotoWorker(request(), Buffer.from('image'), new AbortController().signal, {
          workerPath: worker,
        }),
      ).toEqual({ kind: 'rejected', reason: 'native_unavailable' });
      expect(alive(Number(await readFile(marker, 'utf8')))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('native photo sandbox admission', () => {
  it('holds the sole execution slot until physical teardown settles, independently of OCR', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
    const started = deferred();
    const release = deferred();
    const runWorker = jest.fn(async (): Promise<NativePhotoResult> => {
      started.resolve();
      await release.promise;
      return { kind: 'rejected', reason: 'unsupported_image' };
    });
    const environment = {
      PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock'),
      SECRET: 'not-allowed',
    };
    const server = await startNativePhotoSandbox(environment, {
      networkInterfaces: () => ({}),
      allowTestSocketPath: true,
      runWorker,
    });
    try {
      expect(environment).not.toHaveProperty('SECRET');
      const client = new NativePhotoSandboxClient(server.socketPath);
      expect(await client.probe()).toMatchObject({ network: 'none', environment: 'allowlist' });
      const first = client.fingerprint(Buffer.from('first'), request());
      await started.promise;
      expect(await client.fingerprint(Buffer.from('second'), request())).toEqual({
        kind: 'rejected',
        reason: 'decode_capacity_exceeded',
      });
      expect(runWorker).toHaveBeenCalledTimes(1);
      release.resolve();
      await first;
      expect(await client.fingerprint(Buffer.from('third'), request())).toEqual({
        kind: 'rejected',
        reason: 'unsupported_image',
      });
      expect(runWorker).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('poisons and recycles the sandbox when containment cannot be verified', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
    const fatalExit = jest.fn();
    const { PhotoNativeContainmentError } = await import('./native-photo-runner');
    const runWorker = jest.fn(async (): Promise<NativePhotoResult> => {
      throw new PhotoNativeContainmentError('unreaped');
    });
    const server = await startNativePhotoSandbox(
      { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
      { networkInterfaces: () => ({}), allowTestSocketPath: true, runWorker, fatalExit },
    );
    try {
      const client = new NativePhotoSandboxClient(server.socketPath);
      await expect(client.fingerprint(Buffer.from('first'), request())).rejects.toThrow(
        'transport',
      );
      expect(fatalExit).toHaveBeenCalledTimes(1);
      await expect(client.fingerprint(Buffer.from('second'), request())).rejects.toThrow(
        'transport',
      );
      expect(runWorker).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the consumer raster smoke through the socket and real native worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
    const server = await startNativePhotoSandbox(
      { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
      {
        networkInterfaces: () => ({}),
        allowTestSocketPath: true,
        runWorker: (input, payload, signal) =>
          runNativePhotoWorker(input, payload, signal, workerOptions),
      },
    );
    try {
      await expect(
        new NativePhotoSandboxClient(server.socketPath).smoke(),
      ).resolves.toBeUndefined();
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
