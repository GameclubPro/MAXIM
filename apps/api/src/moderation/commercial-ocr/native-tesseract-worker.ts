import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { COMMERCIAL_OCR_NATIVE_ORCHESTRATION } from './commercial-ocr-behavior-identity';
import { probeNativeTesseract, runNativeTesseract } from './native-tesseract-runner';
import type {
  NativeTesseractWorkerRecognizeRequest,
  NativeTesseractWorkerResponse,
} from './native-tesseract-worker.protocol';
import { isNativeTesseractWorkerRequest } from './native-tesseract-worker-validation';

const binary = process.env.COMMERCIAL_OCR_TESSERACT_BINARY?.trim() || 'tesseract';
const tessdataPrefix = process.env.COMMERCIAL_OCR_TESSDATA_PREFIX?.trim() || undefined;
const maxOutputBytes = readPositiveInteger(
  process.env.COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES,
  4 * 1024 * 1024,
);
const maxImageBytes = readPositiveInteger(
  process.env.COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES,
  16 * 1024 * 1024,
);
const maxTimeoutMs = readPositiveInteger(process.env.COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS, 10_000);
const ompThreadLimit = readBoundedPositiveInteger(process.env.OMP_THREAD_LIMIT, 1, 8);
const STARTUP_PROBE_TIMEOUT_MS =
  COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerStartupProbeTimeoutMs;
const STARTUP_PROBE_MAX_OUTPUT_BYTES =
  COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerStartupProbeMaxOutputBytes;

export type NativeTesseractWorkerHost = {
  readonly connected: boolean;
  readonly send?: (
    response: NativeTesseractWorkerResponse,
    callback?: (error: Error | null) => void,
  ) => boolean;
  on: (event: 'message', listener: (request: unknown) => void) => unknown;
  once: (event: 'disconnect' | 'SIGTERM' | 'SIGINT', listener: () => void) => unknown;
  exit: (exitCode?: number) => unknown;
};

type NativeTesseractWorkerDependencies = {
  probeNativeTesseract: typeof probeNativeTesseract;
  runNativeTesseract: typeof runNativeTesseract;
};

export function startNativeTesseractWorker(
  host: NativeTesseractWorkerHost = process as NativeTesseractWorkerHost,
  dependencies: NativeTesseractWorkerDependencies = {
    probeNativeTesseract,
    runNativeTesseract,
  },
): void {
  let activeNativeProcess: ChildProcessWithoutNullStreams | null = null;
  let initializing = true;
  let ready = false;
  let busy = false;
  let shuttingDown = false;
  let shutdownExitCode = 0;

  const send = (
    response: NativeTesseractWorkerResponse,
    callback?: (error: Error | null) => void,
  ): void => {
    if (!host.connected || !host.send) {
      callback?.(new Error('Tesseract worker IPC is disconnected'));
      return;
    }
    try {
      host.send(response, (error) => callback?.(error ?? null));
    } catch (error: unknown) {
      callback?.(error instanceof Error ? error : new Error('Tesseract worker IPC failed'));
    }
  };

  const killActiveNativeProcess = (): void => {
    try {
      activeNativeProcess?.kill('SIGKILL');
    } catch {
      // Exiting the host worker remains the final containment boundary.
    }
  };

  const retireAfterResponse = (response: NativeTesseractWorkerResponse): void => {
    shutdownExitCode = Math.max(shutdownExitCode, 1);
    shuttingDown = true;
    ready = false;
    killActiveNativeProcess();
    send(response, () => host.exit(shutdownExitCode));
  };

  const handleRecognize = async (request: NativeTesseractWorkerRecognizeRequest): Promise<void> => {
    if (!ready || busy || shuttingDown) {
      send({
        type: 'result',
        jobId: request.jobId,
        retireWorker: false,
        result: { ok: false, reason: 'tesseract_failed' },
      });
      return;
    }
    busy = true;
    let retiringAfterResponse = false;
    try {
      const result = await dependencies.runNativeTesseract({
        binary,
        tessdataPrefix,
        image: Buffer.from(request.image),
        psm: request.psm,
        timeoutMs: request.timeoutMs,
        maxOutputBytes,
        ompThreadLimit,
        onProcessChange: (child) => {
          activeNativeProcess = child;
        },
      });
      const response = {
        type: 'result',
        jobId: request.jobId,
        retireWorker: activeNativeProcess !== null,
        result,
      } satisfies NativeTesseractWorkerResponse;
      if (response.retireWorker) {
        retiringAfterResponse = true;
        retireAfterResponse(response);
        return;
      }
      send(response);
    } finally {
      busy = false;
      if (shuttingDown && !retiringAfterResponse) {
        host.exit(shutdownExitCode);
      }
    }
  };

  const shutdown = (exitCode = 0): void => {
    shutdownExitCode = Math.max(shutdownExitCode, exitCode);
    if (!shuttingDown) {
      shuttingDown = true;
      ready = false;
    }
    killActiveNativeProcess();
    if (!initializing && !busy) {
      host.exit(shutdownExitCode);
    }
  };

  const initialize = async (): Promise<void> => {
    const result = await dependencies.probeNativeTesseract({
      binary,
      tessdataPrefix,
      timeoutMs: STARTUP_PROBE_TIMEOUT_MS,
      maxOutputBytes: STARTUP_PROBE_MAX_OUTPUT_BYTES,
      onProcessChange: (child) => {
        activeNativeProcess = child;
      },
    });
    initializing = false;
    if (shuttingDown) {
      host.exit(shutdownExitCode);
      return;
    }
    if (!result.ok) {
      host.exit(1);
      return;
    }
    ready = true;
    send({ type: 'ready' });
  };

  host.on('message', (request: unknown) => {
    if (!isNativeTesseractWorkerRequest(request, { maxImageBytes, maxTimeoutMs })) {
      shutdown(1);
      return;
    }
    if (request.type === 'shutdown') {
      shutdown();
      return;
    }
    if (shuttingDown) {
      return;
    }
    void handleRecognize(request);
  });
  host.once('disconnect', () => shutdown());
  host.once('SIGTERM', () => shutdown());
  host.once('SIGINT', () => shutdown());

  void initialize().catch(() => host.exit(1));
}

if (require.main === module) {
  startNativeTesseractWorker();
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}
