import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeOcrSandboxClient } from './native-ocr-sandbox.client';
import {
  assertNativeOcrSandboxNetworkIsolated,
  startNativeOcrSandboxServer,
  type NativeOcrSandboxServerDependencies,
} from './native-ocr-sandbox.server';

describe('native OCR sandbox server containment', () => {
  it('serves preprocessing and recognition over the same bounded Unix protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-roundtrip-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    const preprocess = jest.fn(async () => ({
      bytes: Buffer.from('prepared'),
      width: 10,
      height: 5,
    }));
    const recognize = jest.fn(async () => ({
      ok: true as const,
      payload: {
        text: 'TEST',
        aggregateConfidence: 95,
        words: [
          {
            text: 'TEST',
            start: 0,
            end: 4,
            confidence: 95,
            lineIndex: 0,
            boundingBox: { left: 0, top: 0, width: 10, height: 5 },
          },
        ],
        lines: [
          {
            text: 'TEST',
            start: 0,
            end: 4,
            confidence: 95,
            wordStartIndex: 0,
            wordEndIndex: 1,
            boundingBox: { left: 0, top: 0, width: 10, height: 5 },
          },
        ],
        truncated: false,
      },
    }));
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      createPreprocessor: async () => ({ prepare: preprocess }),
      runNativeTesseract: recognize as NativeOcrSandboxServerDependencies['runNativeTesseract'],
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      const prepared = await client.preprocess(Buffer.from('source'), 'primary', 1_000);
      expect(prepared).toEqual({ bytes: Buffer.from('prepared'), width: 10, height: 5 });
      await expect(client.recognize(prepared.bytes, 6, 1_000)).resolves.toMatchObject({
        ok: true,
        payload: { text: 'TEST', aggregateConfidence: 95 },
      });
      expect(preprocess).toHaveBeenCalledTimes(1);
      expect(recognize).toHaveBeenCalledTimes(1);
      expect(client.isVerified()).toBe(true);
    } finally {
      client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('terminates and verifies an active native process group before shutdown completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-server-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    let resolveNative!: (result: { ok: false; reason: 'timeout' }) => void;
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve;
    });
    const nativeResult = new Promise<{ ok: false; reason: 'timeout' }>((resolve) => {
      resolveNative = resolve;
    });
    const child = { pid: 432, kill: jest.fn() } as unknown as ChildProcessWithoutNullStreams;
    const signalGroup = jest.fn(() => {
      resolveNative({ ok: false, reason: 'timeout' });
      return true;
    });
    const verifyGroup = jest.fn(async () => true);
    const fatalExit = jest.fn();
    const dependencies: Partial<NativeOcrSandboxServerDependencies> = {
      allowTestSocketPath: true,
      networkInterfaces: (() => ({
        lo: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      })) as NativeOcrSandboxServerDependencies['networkInterfaces'],
      verifyNativeIdentity: async (_config, expected) => ({
        verified: true,
        status: 'verified',
        mismatches: [],
        identity: { ...expected, complete: true },
      }),
      probeNativeTesseract: jest.fn(
        async () => ({ ok: true }) as const,
      ) as NativeOcrSandboxServerDependencies['probeNativeTesseract'],
      runNativeTesseract: jest.fn(async (options) => {
        options.onProcessChange?.(child);
        markNativeStarted();
        return nativeResult;
      }) as NativeOcrSandboxServerDependencies['runNativeTesseract'],
      createPreprocessor: async () => ({
        prepare: async () => ({ bytes: Buffer.from('prepared'), width: 1, height: 1 }),
      }),
      signalNativeProcessGroup: signalGroup,
      verifyNativeProcessGroupTeardown: verifyGroup,
      fatalExit,
    };

    const server = await startNativeOcrSandboxServer(environment, dependencies);
    const client = new NativeOcrSandboxClient(testClientConfig(environment));
    try {
      const recognition = client.recognize(Buffer.from('prepared'), 6, 5_000);
      const recognitionOutcome = expect(recognition).rejects.toMatchObject({
        reason: expect.stringMatching(/^(?:unavailable|invalid_response)$/u),
      });
      await nativeStarted;
      await server.close();
      await recognitionOutcome;
      expect(signalGroup).toHaveBeenCalledWith(child, 'SIGKILL', {
        requireIsolatedGroup: true,
      });
      expect(verifyGroup).toHaveBeenCalledWith(child, {
        graceMs: 500,
        requireIsolatedGroup: true,
      });
      expect(fatalExit).not.toHaveBeenCalled();
    } finally {
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('observes a client deadline disconnect and cancels active native work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-cancel-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve;
    });
    let resolveNative!: (result: { ok: false; reason: 'tesseract_failed' }) => void;
    const nativeResult = new Promise<{ ok: false; reason: 'tesseract_failed' }>((resolve) => {
      resolveNative = resolve;
    });
    const child = { pid: 433, kill: jest.fn() } as unknown as ChildProcessWithoutNullStreams;
    const signalGroup = jest.fn(() => {
      resolveNative({ ok: false, reason: 'tesseract_failed' });
      return true;
    });
    const fatalExit = jest.fn();
    const previousExitCode = process.exitCode;
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      runNativeTesseract: jest.fn(async (options) => {
        options.onProcessChange?.(child);
        markNativeStarted();
        return nativeResult;
      }) as NativeOcrSandboxServerDependencies['runNativeTesseract'],
      signalNativeProcessGroup: signalGroup,
      verifyNativeProcessGroupTeardown: jest.fn(async () => true),
      fatalExit,
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      const recognition = client.recognize(Buffer.from('prepared'), 6, 1);
      const outcome = expect(recognition).rejects.toMatchObject({ reason: 'unavailable' });
      await nativeStarted;
      await outcome;
      await waitFor(() => signalGroup.mock.calls.length > 0);
      expect(signalGroup).toHaveBeenCalledWith(child, 'SIGKILL', {
        requireIsolatedGroup: true,
      });
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recycles the sandbox when the client disconnects during active Sharp preprocessing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-preprocess-cancel-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    let markPreprocessStarted!: () => void;
    const preprocessStarted = new Promise<void>((resolve) => {
      markPreprocessStarted = resolve;
    });
    let resolvePreprocess!: (result: { bytes: Buffer; width: number; height: number }) => void;
    const preprocessResult = new Promise<{ bytes: Buffer; width: number; height: number }>(
      (resolve) => {
        resolvePreprocess = resolve;
      },
    );
    const fatalExit = jest.fn();
    const previousExitCode = process.exitCode;
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      createPreprocessor: async () => ({
        prepare: async () => {
          markPreprocessStarted();
          return preprocessResult;
        },
      }),
      fatalExit,
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      const preprocessing = client.preprocess(Buffer.from('source'), 'primary', 5_000);
      const outcome = expect(preprocessing).rejects.toMatchObject({ reason: 'unavailable' });
      await preprocessStarted;
      client.close();
      await outcome;
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(process.exitCode).toBe(1);
      resolvePreprocess({ bytes: Buffer.from('prepared'), width: 1, height: 1 });
    } finally {
      process.exitCode = previousExitCode;
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('kills and recycles a native process that starts after its client socket closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-late-native-cancel-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    let markRecognitionEntered!: () => void;
    const recognitionEntered = new Promise<void>((resolve) => {
      markRecognitionEntered = resolve;
    });
    let releaseNativeStart!: () => void;
    const nativeStartReleased = new Promise<void>((resolve) => {
      releaseNativeStart = resolve;
    });
    let resolveNative!: (result: { ok: false; reason: 'tesseract_failed' }) => void;
    const nativeResult = new Promise<{ ok: false; reason: 'tesseract_failed' }>((resolve) => {
      resolveNative = resolve;
    });
    const child = { pid: 434, kill: jest.fn() } as unknown as ChildProcessWithoutNullStreams;
    const signalGroup = jest.fn(() => {
      resolveNative({ ok: false, reason: 'tesseract_failed' });
      return true;
    });
    const fatalExit = jest.fn();
    const previousExitCode = process.exitCode;
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      runNativeTesseract: jest.fn(async (options) => {
        markRecognitionEntered();
        await nativeStartReleased;
        options.onProcessChange?.(child);
        return nativeResult;
      }) as NativeOcrSandboxServerDependencies['runNativeTesseract'],
      signalNativeProcessGroup: signalGroup,
      fatalExit,
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      const recognition = client.recognize(Buffer.from('prepared'), 6, 5_000);
      const outcome = expect(recognition).rejects.toMatchObject({ reason: 'unavailable' });
      await recognitionEntered;
      client.close();
      await outcome;
      releaseNativeStart();
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(signalGroup).toHaveBeenCalledWith(child, 'SIGKILL', {
        requireIsolatedGroup: true,
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      releaseNativeStart();
      resolveNative({ ok: false, reason: 'tesseract_failed' });
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recycles the whole sandbox after a forced native timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-recycle-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    const fatalExit = jest.fn();
    const previousExitCode = process.exitCode;
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      runNativeTesseract: jest.fn(async () => ({ ok: false, reason: 'timeout' }) as const),
      fatalExit,
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      await client.recognize(Buffer.from('prepared'), 6, 1_000).catch(() => undefined);
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects any non-loopback interface before binding the socket', () => {
    expect(() =>
      assertNativeOcrSandboxNetworkIsolated({
        eth0: [
          {
            address: '10.0.0.2',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '10.0.0.2/24',
          },
        ],
      }),
    ).toThrow('non-loopback');
  });
});

function sandboxEnvironment(socketPath: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    NODE_ENV: 'test',
    OMP_THREAD_LIMIT: '1',
    COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: socketPath,
    COMMERCIAL_OCR_TESSERACT_CONCURRENCY: '1',
    COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: '4',
    COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
  };
}

function successfulServerDependencies(): Partial<NativeOcrSandboxServerDependencies> {
  return {
    allowTestSocketPath: true,
    networkInterfaces: (() => ({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    })) as NativeOcrSandboxServerDependencies['networkInterfaces'],
    verifyNativeIdentity: async (_config, expected) => ({
      verified: true,
      status: 'verified',
      mismatches: [],
      identity: { ...expected, complete: true },
    }),
    probeNativeTesseract: jest.fn(
      async () => ({ ok: true }) as const,
    ) as NativeOcrSandboxServerDependencies['probeNativeTesseract'],
    fatalExit: jest.fn(),
  };
}

function testClientConfig(environment: NodeJS.ProcessEnv) {
  return {
    get: (key: string): unknown => (key === 'NODE_ENV' ? 'test' : environment[key]),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadlineAt = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadlineAt) throw new Error('Timed out waiting for sandbox test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
