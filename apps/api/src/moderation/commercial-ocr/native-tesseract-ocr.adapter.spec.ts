import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { NativeTesseractOcrAdapter } from './native-tesseract-ocr.adapter';
import type {
  NativeTesseractWorkerRequest,
  NativeTesseractWorkerResponse,
} from './native-tesseract-worker.protocol';

class FakeWorker extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly requests: NativeTesseractWorkerRequest[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  onRequest?: (request: NativeTesseractWorkerRequest) => void;
  sendError: Error | null = null;

  constructor() {
    super();
    queueMicrotask(() =>
      this.emit('message', { type: 'ready' } satisfies NativeTesseractWorkerResponse),
    );
  }

  send(request: NativeTesseractWorkerRequest, callback?: (error: Error | null) => void): boolean {
    this.requests.push(request);
    queueMicrotask(() => {
      callback?.(this.sendError);
      this.onRequest?.(request);
    });
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.connected = false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }

  respond(jobId: string, text = 'Ремонт окон'): void {
    this.emit('message', {
      type: 'result',
      jobId,
      retireWorker: false,
      result: {
        ok: true,
        payload: {
          text,
          aggregateConfidence: text ? 91 : null,
          words: text
            ? [
                {
                  text,
                  start: 0,
                  end: text.length,
                  confidence: 91,
                  lineIndex: 0,
                  boundingBox: { left: 0, top: 0, width: 100, height: 20 },
                },
              ]
            : [],
          lines: text
            ? [
                {
                  text,
                  start: 0,
                  end: text.length,
                  confidence: 91,
                  wordStartIndex: 0,
                  wordEndIndex: 1,
                  boundingBox: { left: 0, top: 0, width: 100, height: 20 },
                },
              ]
            : [],
          truncated: false,
        },
      },
    } satisfies NativeTesseractWorkerResponse);
  }

  fail(
    jobId: string,
    reason: 'timeout' | 'tesseract_failed' | 'output_limit' | 'invalid_output',
    retireWorker = false,
  ): void {
    this.emit('message', {
      type: 'result',
      jobId,
      retireWorker,
      result: { ok: false, reason },
    } satisfies NativeTesseractWorkerResponse);
  }
}

class StubbornFakeWorker extends FakeWorker {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

class TestNativeTesseractOcrAdapter extends NativeTesseractOcrAdapter {
  readonly workers: FakeWorker[] = [];
  readonly workerEnvironments: NodeJS.ProcessEnv[] = [];

  protected override forkWorker(_path: string, options: Parameters<typeof fork>[2]): ChildProcess {
    const worker = new FakeWorker();
    this.workers.push(worker);
    this.workerEnvironments.push(options?.env ?? {});
    return worker as unknown as ChildProcess;
  }
}

class TestStubbornNativeTesseractOcrAdapter extends NativeTesseractOcrAdapter {
  readonly worker = new StubbornFakeWorker();

  protected override forkWorker(): ChildProcess {
    return this.worker as unknown as ChildProcess;
  }
}

describe('NativeTesseractOcrAdapter', () => {
  const services: TestNativeTesseractOcrAdapter[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
  });

  it('preserves the pass label and permits only the bounded PSM set', async () => {
    const service = createService();
    services.push(service);
    const recognition = service.recognize(Buffer.from('image'), {
      psm: 6,
      passLabel: 'confirmation:binary',
    });
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);
    expect(request).toMatchObject({ psm: 6 });
    worker.respond(request.jobId);

    await expect(recognition).resolves.toMatchObject({
      ok: true,
      status: 'recognized',
      psm: 6,
      passLabel: 'confirmation:binary',
      aggregateConfidence: 91,
    });
    await expect(
      service.recognize(Buffer.from('image'), {
        psm: 3 as 6,
        passLabel: 'invalid label with spaces',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_input' });
  });

  it('propagates all native resource ceilings to the worker environment', async () => {
    const service = createService({
      OMP_THREAD_LIMIT: 2,
      COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: 2_000_000,
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 1_750,
    });
    services.push(service);
    service.onModuleInit();
    await readyWorker(service, 0);

    expect(service.workerEnvironments[0]).toMatchObject({
      OMP_THREAD_LIMIT: '2',
      COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: '2000000',
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '1750',
    });
  });

  it('rejects an expired absolute deadline before initializing a worker', async () => {
    const service = createService();
    services.push(service);

    await expect(
      service.recognize(Buffer.from('private pixels'), { deadlineAtMs: Date.now() }),
    ).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(service.workers).toHaveLength(0);
    expect(service.getRuntimeStatus()).toMatchObject({
      state: 'starting',
      ready: false,
      workers: { live: 0, ready: 0, busy: 0 },
      queueDepth: 0,
    });
  });

  it('bounds the worker request timeout by the caller absolute deadline', async () => {
    const service = createService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000 });
    services.push(service);
    const recognition = service.recognize(Buffer.from('image'), {
      deadlineAtMs: Date.now() + 2_000,
    });
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);

    expect(request.timeoutMs).toBeGreaterThan(0);
    expect(request.timeoutMs).toBeLessThanOrEqual(1_500);
    worker.respond(request.jobId);
    await expect(recognition).resolves.toMatchObject({ ok: true });
  });

  it('reserves watchdog grace inside a caller absolute deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    const performanceNow = jest.spyOn(performance, 'now').mockReturnValue(0);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 10_000 }),
    );
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const recognition = service.recognize(Buffer.from('image'), {
        deadlineAtMs: Date.now() + 9_000,
      });
      const request = worker.requests.find((candidate) => candidate.type === 'recognize');
      if (!request || request.type !== 'recognize') {
        throw new Error('Expected a recognize request');
      }
      expect(request.timeoutMs).toBe(8_500);

      await jest.advanceTimersByTimeAsync(8_500);
      worker.fail(request.jobId, 'timeout');

      await expect(recognition).resolves.toMatchObject({ ok: false, reason: 'timeout' });
      expect(worker.killSignals).toEqual([]);
      expect(service.getRuntimeStatus().counters).toMatchObject({ restarts: 0 });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('does not start native work without enough caller budget for watchdog grace', async () => {
    const service = createService();
    services.push(service);

    await expect(
      service.recognize(Buffer.from('private pixels'), {
        deadlineAtMs: Date.now() + 500,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(service.workers).toHaveLength(0);
  });

  it('uses a ten-second native budget and keeps the worker alive for a native timeout', async () => {
    jest.useFakeTimers();
    const performanceNow = jest.spyOn(performance, 'now').mockReturnValue(0);
    const service = new TestNativeTesseractOcrAdapter(new ConfigService({}));
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const recognition = service.recognize(Buffer.from('image'));
      const request = worker.requests.find((candidate) => candidate.type === 'recognize');
      if (!request || request.type !== 'recognize') {
        throw new Error('Expected a recognize request');
      }
      expect(request.timeoutMs).toBe(10_000);

      let settled = false;
      void recognition.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);

      worker.fail(request.jobId, 'timeout');
      await expect(recognition).resolves.toMatchObject({ ok: false, reason: 'timeout' });
      expect(service.workers).toHaveLength(1);
      expect(worker.killSignals).toEqual([]);
      expect(service.getRuntimeStatus()).toMatchObject({
        ready: true,
        counters: {
          failed: 1,
          restarts: 0,
          failuresByReason: { timeout: 1 },
        },
      });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('recycles and reports an unavailable worker that misses the result watchdog grace', async () => {
    jest.useFakeTimers();
    const performanceNow = jest.spyOn(performance, 'now').mockReturnValue(0);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 250 }),
    );
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const recognition = service.recognize(Buffer.from('image'));
      expect(worker.requests).toContainEqual(expect.objectContaining({ timeoutMs: 250 }));

      let settled = false;
      void recognition.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(749);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      await expect(recognition).resolves.toMatchObject({
        ok: false,
        reason: 'worker_unavailable',
      });
      await jest.advanceTimersByTimeAsync(1);
      expect(service.workers).toHaveLength(2);
      expect(worker.killSignals).toContain('SIGTERM');
      expect(service.getRuntimeStatus().counters).toMatchObject({
        failed: 1,
        restarts: 1,
        failuresByReason: { worker_unavailable: 1 },
      });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('keeps an explicit worker send failure retryable', async () => {
    const service = createService();
    services.push(service);
    service.onModuleInit();
    const worker = await readyWorker(service, 0);
    worker.sendError = new Error('IPC send failed');

    const recognition = service.recognize(Buffer.from('image'));

    await expect(recognition).resolves.toMatchObject({
      ok: false,
      reason: 'worker_unavailable',
    });
    await expect(readyWorker(service, 1)).resolves.not.toBe(worker);
    expect(service.getRuntimeStatus().counters).toMatchObject({
      failed: 1,
      restarts: 1,
      failuresByReason: { worker_unavailable: 1 },
    });
  });

  it('dispatches queued work only after a retiring worker is replaced', async () => {
    const service = createService();
    services.push(service);
    const first = service.recognize(Buffer.from('first'));
    const firstWorker = await readyWorker(service, 0);
    const firstRequest = await recognizeRequest(firstWorker);
    const second = service.recognize(Buffer.from('second'));

    firstWorker.fail(firstRequest.jobId, 'timeout', true);

    await expect(first).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(firstWorker.requests.filter((request) => request.type === 'recognize')).toHaveLength(1);
    const secondWorker = await readyWorker(service, 1);
    expect(secondWorker).not.toBe(firstWorker);
    const secondRequest = await recognizeRequest(secondWorker);
    secondWorker.respond(secondRequest.jobId, 'Второй');
    await expect(second).resolves.toMatchObject({ ok: true, text: 'Второй' });
  });

  it('fails work whose native budget expires in the adapter queue as capacity pressure', async () => {
    jest.useFakeTimers();
    let monotonicNowMs = 0;
    const performanceNow = jest.spyOn(performance, 'now').mockImplementation(() => monotonicNowMs);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 250 }),
    );
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const first = service.recognize(Buffer.from('first'));
      const firstRequest = worker.requests.find((candidate) => candidate.type === 'recognize');
      if (!firstRequest || firstRequest.type !== 'recognize') {
        throw new Error('Expected the first recognize request');
      }
      const queued = service.recognize(Buffer.from('queued'));

      monotonicNowMs = 251;
      worker.respond(firstRequest.jobId);

      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(queued).resolves.toMatchObject({
        ok: false,
        reason: 'capacity_exhausted',
      });
      expect(service.workers).toHaveLength(1);
      expect(worker.killSignals).toEqual([]);
      expect(service.getRuntimeStatus().counters).toMatchObject({
        completed: 1,
        failed: 1,
        restarts: 0,
        failuresByReason: { capacity_exhausted: 1 },
      });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('bounds active work and its waiting queue', async () => {
    const service = createService({
      COMMERCIAL_OCR_TESSERACT_CONCURRENCY: 1,
      COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: 1,
    });
    services.push(service);
    const first = service.recognize(Buffer.from('first'));
    const worker = await readyWorker(service, 0);
    const firstRequest = await recognizeRequest(worker);
    const second = service.recognize(Buffer.from('second'));

    await expect(service.recognize(Buffer.from('third'))).resolves.toMatchObject({
      ok: false,
      status: 'failed_open',
      reason: 'capacity_exhausted',
    });

    worker.respond(firstRequest.jobId, 'Первый');
    await expect(first).resolves.toMatchObject({ ok: true, text: 'Первый' });
    const secondRequest = await recognizeRequest(worker, 1);
    worker.respond(secondRequest.jobId, 'Второй');
    await expect(second).resolves.toMatchObject({ ok: true, text: 'Второй' });
  });

  it('recycles a host worker after the configured number of jobs', async () => {
    const service = createService({ COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: 1 });
    services.push(service);
    const first = service.recognize(Buffer.from('first'));
    const firstWorker = await readyWorker(service, 0);
    const firstRequest = await recognizeRequest(firstWorker);
    firstWorker.respond(firstRequest.jobId);
    await expect(first).resolves.toMatchObject({ ok: true });

    const secondWorker = await readyWorker(service, 1);
    expect(secondWorker).not.toBe(firstWorker);
    expect(service.getRuntimeStatus().counters).toMatchObject({
      completed: 1,
      failed: 0,
      restarts: 1,
      recycles: 1,
    });
    const second = service.recognize(Buffer.from('second'));
    const secondRequest = await recognizeRequest(secondWorker);
    secondWorker.respond(secondRequest.jobId);
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('fails open and recycles a worker that returns an unknown failure reason', async () => {
    const service = createService();
    services.push(service);
    const recognition = service.recognize(Buffer.from('image'));
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);

    worker.emit('message', {
      type: 'result',
      jobId: request.jobId,
      result: { ok: false, reason: 'capacity_exhausted' },
    });

    await expect(recognition).resolves.toMatchObject({
      ok: false,
      status: 'failed_open',
      reason: 'invalid_output',
    });
    await expect(readyWorker(service, 1)).resolves.not.toBe(worker);
    expect(service.getRuntimeStatus().counters).toMatchObject({
      completed: 0,
      failed: 1,
      restarts: 1,
      failuresByReason: { invalid_output: 1 },
    });
  });

  it('exposes only aggregate privacy-safe runtime status', async () => {
    const service = createService();
    services.push(service);
    const privateImage = Buffer.from('private-image-pixels');
    const recognition = service.recognize(privateImage, { passLabel: 'private-pass' });
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);
    worker.respond(request.jobId, 'СЕКРЕТНЫЙ OCR ТЕКСТ');
    await expect(recognition).resolves.toMatchObject({ ok: true });

    const status = service.getRuntimeStatus();
    expect(status).toMatchObject({
      state: 'ready',
      ready: true,
      workers: { configured: 1, live: 1, ready: 1, busy: 0 },
      queueDepth: 0,
      counters: { completed: 1, failed: 0 },
    });
    const serialized = JSON.stringify(status);
    for (const privateValue of [
      'СЕКРЕТНЫЙ OCR ТЕКСТ',
      privateImage.toString('base64'),
      request.jobId,
      'private-pass',
      'https://',
      'image',
      'text',
      'jobId',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('fails queued and active work open during shutdown', async () => {
    const service = createService();
    const active = service.recognize(Buffer.from('active'));
    await readyWorker(service, 0);
    const queued = service.recognize(Buffer.from('queued'));
    await service.onModuleDestroy();

    await expect(active).resolves.toMatchObject({ ok: false, reason: 'shutting_down' });
    await expect(queued).resolves.toMatchObject({ ok: false, reason: 'shutting_down' });
    await expect(service.recognize(Buffer.from('late'))).resolves.toMatchObject({
      ok: false,
      reason: 'shutting_down',
    });
  });

  it('quarantines late errors until a stubborn worker exits after shutdown', async () => {
    jest.useFakeTimers();
    try {
      const service = new TestStubbornNativeTesseractOcrAdapter(
        new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000 }),
      );
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(service.getRuntimeStatus().ready).toBe(true);

      const shutdown = service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(1_249);
      expect(service.worker.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      await jest.advanceTimersByTimeAsync(1);
      await expect(shutdown).resolves.toBeUndefined();

      expect(service.getRuntimeStatus()).toMatchObject({
        state: 'shutting_down',
        ready: false,
        workers: { live: 0, ready: 0, busy: 0 },
      });
      expect(service.worker.listenerCount('message')).toBe(0);
      expect(service.worker.listenerCount('error')).toBe(1);
      expect(service.worker.listenerCount('exit')).toBe(1);

      expect(() => service.worker.emit('error', new Error('late child error'))).not.toThrow();
      service.worker.exitCode = 1;
      service.worker.emit('exit', 1, null);

      expect(service.worker.listenerCount('error')).toBe(0);
      expect(service.worker.listenerCount('exit')).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

function createService(config: Record<string, unknown> = {}): TestNativeTesseractOcrAdapter {
  return new TestNativeTesseractOcrAdapter(
    new ConfigService({
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000,
      ...config,
    }),
  );
}

async function readyWorker(
  service: TestNativeTesseractOcrAdapter,
  index: number,
): Promise<FakeWorker> {
  await waitFor(() => service.workers[index]);
  const worker = service.workers[index];
  await new Promise((resolve) => setImmediate(resolve));
  return worker;
}

async function recognizeRequest(worker: FakeWorker, index = 0) {
  await waitFor(() => worker.requests.filter((request) => request.type === 'recognize')[index]);
  const request = worker.requests.filter((candidate) => candidate.type === 'recognize')[index];
  if (request.type !== 'recognize') {
    throw new Error('Expected a recognize request');
  }
  return request;
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for test state');
}
