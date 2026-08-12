import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';

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
  onRequest?: (request: NativeTesseractWorkerRequest) => void;

  constructor() {
    super();
    queueMicrotask(() =>
      this.emit('message', { type: 'ready' } satisfies NativeTesseractWorkerResponse),
    );
  }

  send(request: NativeTesseractWorkerRequest, callback?: (error: Error | null) => void): boolean {
    this.requests.push(request);
    queueMicrotask(() => {
      callback?.(null);
      this.onRequest?.(request);
    });
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
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

  it('propagates the bounded OpenMP thread limit to the native worker', async () => {
    const service = createService({ OMP_THREAD_LIMIT: 2 });
    services.push(service);
    service.onModuleInit();
    await readyWorker(service, 0);

    expect(service.workerEnvironments[0]).toMatchObject({ OMP_THREAD_LIMIT: '2' });
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
