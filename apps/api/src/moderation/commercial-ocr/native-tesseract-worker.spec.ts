import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  startNativeTesseractWorker,
  type NativeTesseractWorkerHost,
} from './native-tesseract-worker';
import type { NativeTesseractWorkerResponse } from './native-tesseract-worker.protocol';
import type {
  NativeTesseractProbeOptions,
  NativeTesseractRunOptions,
} from './native-tesseract-runner';

class FakeWorkerHost extends EventEmitter implements NativeTesseractWorkerHost {
  connected = true;
  readonly responses: NativeTesseractWorkerResponse[] = [];
  readonly exitCodes: number[] = [];

  send(response: NativeTesseractWorkerResponse, callback?: (error: Error | null) => void): boolean {
    this.responses.push(response);
    queueMicrotask(() => callback?.(null));
    return true;
  }

  exit(exitCode = 0): void {
    this.exitCodes.push(exitCode);
  }
}

class StubbornNativeProcess extends EventEmitter {
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

describe('native Tesseract worker lifecycle', () => {
  it('retires after forced settlement without a confirmed native close', async () => {
    const host = new FakeWorkerHost();
    const nativeProcess = new StubbornNativeProcess();
    const probe = jest.fn(async (_options: NativeTesseractProbeOptions) => ({ ok: true }) as const);
    const run = jest.fn(async (options: NativeTesseractRunOptions) => {
      options.onProcessChange?.(nativeProcess as unknown as ChildProcessWithoutNullStreams);
      return { ok: false, reason: 'timeout' } as const;
    });
    startNativeTesseractWorker(host, {
      probeNativeTesseract: probe,
      runNativeTesseract: run,
    });
    await flushTasks();

    host.emit('message', recognizeRequest('00000000-0000-4000-8000-000000000001'));
    await flushTasks();

    expect(host.responses).toEqual([
      { type: 'ready' },
      {
        type: 'result',
        jobId: '00000000-0000-4000-8000-000000000001',
        retireWorker: true,
        result: { ok: false, reason: 'timeout' },
      },
    ]);
    expect(nativeProcess.killSignals).toEqual(['SIGKILL']);
    expect(host.exitCodes).toEqual([1]);

    host.emit('message', recognizeRequest('00000000-0000-4000-8000-000000000002'));
    await flushTasks();

    expect(run).toHaveBeenCalledTimes(1);
    expect(host.responses).toHaveLength(2);
  });

  it('stays available when native process closure was confirmed', async () => {
    const host = new FakeWorkerHost();
    const nativeProcess = new StubbornNativeProcess();
    const run = jest.fn(async (options: NativeTesseractRunOptions) => {
      options.onProcessChange?.(nativeProcess as unknown as ChildProcessWithoutNullStreams);
      options.onProcessChange?.(null);
      return { ok: false, reason: 'timeout' } as const;
    });
    startNativeTesseractWorker(host, {
      probeNativeTesseract: async () => ({ ok: true }),
      runNativeTesseract: run,
    });
    await flushTasks();

    host.emit('message', recognizeRequest('00000000-0000-4000-8000-000000000001'));
    await flushTasks();
    host.emit('message', recognizeRequest('00000000-0000-4000-8000-000000000002'));
    await flushTasks();

    expect(run).toHaveBeenCalledTimes(2);
    expect(host.responses).toEqual([
      { type: 'ready' },
      expect.objectContaining({ retireWorker: false }),
      expect.objectContaining({ retireWorker: false }),
    ]);
    expect(nativeProcess.killSignals).toEqual([]);
    expect(host.exitCodes).toEqual([]);
  });
});

function recognizeRequest(jobId: string) {
  return {
    type: 'recognize',
    jobId,
    image: Buffer.from('image'),
    psm: 11,
    timeoutMs: 1_000,
  } as const;
}

async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
