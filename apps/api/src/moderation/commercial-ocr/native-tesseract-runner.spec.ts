import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

import {
  probeNativeTesseract,
  runNativeTesseract,
  type NativeTesseractSpawn,
} from './native-tesseract-runner';

const HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: NodeJS.Signals | number | undefined;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal;
    queueMicrotask(() => this.emit('close', null, signal ?? 'SIGTERM'));
    return true;
  }
}

class StubbornFakeChildProcess extends FakeChildProcess {
  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal;
    return true;
  }
}

describe('probeNativeTesseract', () => {
  it('launches a bounded shell-free language probe and requires exact rus and eng lines', async () => {
    const child = new FakeChildProcess();
    let captured:
      | { command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }
      | undefined;
    const spawnProcess: NativeTesseractSpawn = (command, args, options) => {
      captured = { command, args, options };
      child.stdin.once('finish', () => {
        child.stdout.end('List of available languages in /models (3):\neng\nosd\nrus\n');
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    };

    await expect(
      probeNativeTesseract(
        {
          binary: '/usr/bin/tesseract',
          timeoutMs: 1_000,
          maxOutputBytes: 64 * 1024,
          tessdataPrefix: '/models',
        },
        spawnProcess,
      ),
    ).resolves.toEqual({ ok: true });
    expect(captured).toEqual(
      expect.objectContaining({
        command: '/usr/bin/tesseract',
        args: ['--list-langs'],
        options: expect.objectContaining({
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
        }),
      }),
    );
    expect(captured?.options.env).toEqual(expect.objectContaining({ TESSDATA_PREFIX: '/models' }));
  });

  it('rejects partial language names and unsuccessful exits', async () => {
    await expect(
      probeNativeTesseract(
        { binary: 'missing', timeoutMs: 1_000, maxOutputBytes: 64 * 1024 },
        (() => {
          throw new Error('missing');
        }) as NativeTesseractSpawn,
      ),
    ).resolves.toEqual({ ok: false, reason: 'tesseract_failed' });

    const missingChild = new FakeChildProcess();
    const missing = probeNativeTesseract(
      { binary: 'tesseract', timeoutMs: 1_000, maxOutputBytes: 64 * 1024 },
      () => missingChild as unknown as ChildProcessWithoutNullStreams,
    );
    missingChild.stdout.end('List of available languages (2):\neng-fast\nrussian\n');
    missingChild.emit('close', 0, null);
    await expect(missing).resolves.toEqual({ ok: false, reason: 'missing_languages' });

    const failedChild = new FakeChildProcess();
    const failed = probeNativeTesseract(
      { binary: 'tesseract', timeoutMs: 1_000, maxOutputBytes: 64 * 1024 },
      () => failedChild as unknown as ChildProcessWithoutNullStreams,
    );
    failedChild.stderr.end('failed to load languages');
    failedChild.emit('close', 1, null);
    await expect(failed).resolves.toEqual({ ok: false, reason: 'tesseract_failed' });
  });

  it('kills probes that exceed their time or output budget', async () => {
    const timedOutChild = new FakeChildProcess();
    const timedOut = probeNativeTesseract(
      { binary: 'tesseract', timeoutMs: 5, maxOutputBytes: 64 * 1024 },
      () => timedOutChild as unknown as ChildProcessWithoutNullStreams,
    );
    await expect(timedOut).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(timedOutChild.killedWith).toBe('SIGKILL');

    const oversizedChild = new FakeChildProcess();
    const oversized = probeNativeTesseract(
      { binary: 'tesseract', timeoutMs: 1_000, maxOutputBytes: 8 },
      () => oversizedChild as unknown as ChildProcessWithoutNullStreams,
    );
    oversizedChild.stdout.write(Buffer.alloc(9));
    await expect(oversized).resolves.toEqual({ ok: false, reason: 'output_limit' });
    expect(oversizedChild.killedWith).toBe('SIGKILL');
  });

  it('settles and detaches every listener when a killed probe never closes', async () => {
    jest.useFakeTimers();
    try {
      const child = new StubbornFakeChildProcess();
      const processChanges: Array<ChildProcessWithoutNullStreams | null> = [];
      const result = probeNativeTesseract(
        {
          binary: 'tesseract',
          timeoutMs: 10,
          maxOutputBytes: 64 * 1024,
          onProcessChange: (process) => processChanges.push(process),
        },
        () => child as unknown as ChildProcessWithoutNullStreams,
      );

      await jest.advanceTimersByTimeAsync(260);

      await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' });
      expect(child.killedWith).toBe('SIGKILL');
      expect(processChanges).toEqual([child]);
      expectLateErrorsGuardedUntilClose(child);
      expect(processChanges).toEqual([child, null]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('runNativeTesseract', () => {
  it('uses fixed arguments, shell=false, stdin image input and parses TSV', async () => {
    const child = new FakeChildProcess();
    let captured:
      | { command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }
      | undefined;
    const spawnProcess: NativeTesseractSpawn = (command, args, options) => {
      captured = { command, args, options };
      child.stdin.once('finish', () => {
        child.stdout.end(`${HEADER}\n5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t92\tРеклама\n`);
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    };

    const result = await runNativeTesseract(
      {
        binary: '/usr/bin/tesseract',
        image: Buffer.from('image'),
        psm: 11,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
        tessdataPrefix: '/models',
        ompThreadLimit: 2,
      },
      spawnProcess,
    );

    expect(captured).toEqual(
      expect.objectContaining({
        command: '/usr/bin/tesseract',
        args: ['stdin', 'stdout', '-l', 'rus+eng', '--oem', '1', '--psm', '11', 'tsv'],
        options: expect.objectContaining({
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
        }),
      }),
    );
    expect(captured?.options.env).toEqual(
      expect.objectContaining({ TESSDATA_PREFIX: '/models', OMP_THREAD_LIMIT: '2' }),
    );
    expect(result).toMatchObject({
      ok: true,
      payload: { text: 'Реклама', aggregateConfidence: 92 },
    });
  });

  it('kills a timed-out native process and fails open', async () => {
    const child = new FakeChildProcess();
    const result = await runNativeTesseract(
      {
        binary: 'tesseract',
        image: Buffer.from('image'),
        psm: 6,
        timeoutMs: 5,
        maxOutputBytes: 64 * 1024,
      },
      () => child as unknown as ChildProcessWithoutNullStreams,
    );

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(child.killedWith).toBe('SIGKILL');
  });

  it('stops output growth at the configured byte limit', async () => {
    const child = new FakeChildProcess();
    const promise = runNativeTesseract(
      {
        binary: 'tesseract',
        image: Buffer.from('image'),
        psm: 11,
        timeoutMs: 1_000,
        maxOutputBytes: 8,
      },
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    child.stdout.write(Buffer.alloc(9));

    await expect(promise).resolves.toEqual({ ok: false, reason: 'output_limit' });
    expect(child.killedWith).toBe('SIGKILL');
  });

  it('maps spawn errors and malformed TSV to fail-open reasons', async () => {
    const spawnFailure = await runNativeTesseract(
      {
        binary: 'missing',
        image: Buffer.from('image'),
        psm: 11,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
      },
      (() => {
        throw new Error('missing');
      }) as NativeTesseractSpawn,
    );
    expect(spawnFailure).toEqual({ ok: false, reason: 'tesseract_failed' });

    const child = new FakeChildProcess();
    const malformed = runNativeTesseract(
      {
        binary: 'tesseract',
        image: Buffer.from('image'),
        psm: 11,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
      },
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    child.stdout.end('not tsv');
    child.emit('close', 0, null);
    await expect(malformed).resolves.toEqual({ ok: false, reason: 'invalid_output' });
  });

  it('settles and detaches every listener when a killed OCR process never closes', async () => {
    jest.useFakeTimers();
    try {
      const child = new StubbornFakeChildProcess();
      const processChanges: Array<ChildProcessWithoutNullStreams | null> = [];
      const result = runNativeTesseract(
        {
          binary: 'tesseract',
          image: Buffer.from('image'),
          psm: 11,
          timeoutMs: 10,
          maxOutputBytes: 64 * 1024,
          onProcessChange: (process) => processChanges.push(process),
        },
        () => child as unknown as ChildProcessWithoutNullStreams,
      );

      await jest.advanceTimersByTimeAsync(260);

      await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' });
      expect(child.killedWith).toBe('SIGKILL');
      expect(processChanges).toEqual([child]);
      expectLateErrorsGuardedUntilClose(child);
      expect(processChanges).toEqual([child, null]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('native Tesseract environment boundary', () => {
  it('does not expose application secrets to probe or OCR subprocesses', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalBotToken = process.env.MAX_BOT_TOKEN;
    const originalPath = process.env.PATH;
    const originalLang = process.env.LANG;
    process.env.DATABASE_URL = 'postgresql://secret';
    process.env.MAX_BOT_TOKEN = 'secret-token';
    process.env.PATH = '/trusted/bin';
    process.env.LANG = 'C.UTF-8';

    try {
      const probeChild = new FakeChildProcess();
      let probeEnvironment: NodeJS.ProcessEnv | undefined;
      const probe = probeNativeTesseract(
        {
          binary: 'tesseract',
          timeoutMs: 1_000,
          maxOutputBytes: 64 * 1024,
          tessdataPrefix: '/models',
        },
        (_command, _args, options) => {
          probeEnvironment = options.env;
          return probeChild as unknown as ChildProcessWithoutNullStreams;
        },
      );
      probeChild.stdout.end('eng\nrus\n');
      probeChild.emit('close', 0, null);
      await expect(probe).resolves.toEqual({ ok: true });

      const runChild = new FakeChildProcess();
      let runEnvironment: NodeJS.ProcessEnv | undefined;
      const recognition = runNativeTesseract(
        {
          binary: 'tesseract',
          image: Buffer.from('image'),
          psm: 11,
          timeoutMs: 1_000,
          maxOutputBytes: 64 * 1024,
          tessdataPrefix: '/models',
          ompThreadLimit: 2,
        },
        (_command, _args, options) => {
          runEnvironment = options.env;
          return runChild as unknown as ChildProcessWithoutNullStreams;
        },
      );
      runChild.stdout.end(`${HEADER}\n`);
      runChild.emit('close', 0, null);
      await expect(recognition).resolves.toMatchObject({ ok: true });

      const allowedKeys = new Set([
        'PATH',
        'LANG',
        'LC_ALL',
        'LD_LIBRARY_PATH',
        'NODE_ENV',
        'TESSDATA_PREFIX',
        'OMP_THREAD_LIMIT',
      ]);
      for (const environment of [probeEnvironment, runEnvironment]) {
        expect(environment).toBeDefined();
        expect(environment).not.toHaveProperty('DATABASE_URL');
        expect(environment).not.toHaveProperty('MAX_BOT_TOKEN');
        expect(Object.keys(environment ?? {}).every((key) => allowedKeys.has(key))).toBe(true);
      }
      expect(probeEnvironment).toMatchObject({
        PATH: '/trusted/bin',
        LANG: 'C.UTF-8',
        TESSDATA_PREFIX: '/models',
      });
      expect(probeEnvironment).not.toHaveProperty('OMP_THREAD_LIMIT');
      expect(runEnvironment).toMatchObject({
        PATH: '/trusted/bin',
        LANG: 'C.UTF-8',
        TESSDATA_PREFIX: '/models',
        OMP_THREAD_LIMIT: '2',
      });
    } finally {
      restoreEnvironment('DATABASE_URL', originalDatabaseUrl);
      restoreEnvironment('MAX_BOT_TOKEN', originalBotToken);
      restoreEnvironment('PATH', originalPath);
      restoreEnvironment('LANG', originalLang);
    }
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function expectLateErrorsGuardedUntilClose(child: FakeChildProcess): void {
  expect(child.stdout.listenerCount('data')).toBe(0);
  expect(child.stderr.listenerCount('data')).toBe(0);
  expect(child.listenerCount('error')).toBe(1);
  expect(child.listenerCount('close')).toBe(1);
  expect(child.stdin.listenerCount('error')).toBe(1);
  expect(child.stdout.listenerCount('error')).toBe(1);
  expect(child.stderr.listenerCount('error')).toBe(1);

  child.emit('error', new Error('late child error'));
  child.stdin.emit('error', new Error('late stdin error'));
  child.stdout.emit('error', new Error('late stdout error'));
  child.stderr.emit('error', new Error('late stderr error'));
  child.emit('close', null, 'SIGKILL');

  expect(child.listenerCount('error')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
  expect(child.stdin.listenerCount('error')).toBe(0);
  expect(child.stdout.listenerCount('error')).toBe(0);
  expect(child.stderr.listenerCount('error')).toBe(0);
}
