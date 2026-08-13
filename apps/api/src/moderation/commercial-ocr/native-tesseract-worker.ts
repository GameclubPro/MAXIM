import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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
const maxTimeoutMs = readPositiveInteger(
  process.env.COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS,
  5_000,
);
const STARTUP_PROBE_TIMEOUT_MS = 4_000;
const STARTUP_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

let activeNativeProcess: ChildProcessWithoutNullStreams | null = null;
let initializing = true;
let ready = false;
let busy = false;
let shuttingDown = false;
let shutdownExitCode = 0;

function send(response: NativeTesseractWorkerResponse): void {
  if (process.connected && process.send) {
    process.send(response);
  }
}

async function handleRecognize(request: NativeTesseractWorkerRecognizeRequest): Promise<void> {
  if (!ready || busy || shuttingDown) {
    send({
      type: 'result',
      jobId: request.jobId,
      result: { ok: false, reason: 'tesseract_failed' },
    });
    return;
  }
  busy = true;
  try {
    const result = await runNativeTesseract({
      binary,
      tessdataPrefix,
      image: Buffer.from(request.image),
      psm: request.psm,
      timeoutMs: request.timeoutMs,
      maxOutputBytes,
      onProcessChange: (child) => {
        activeNativeProcess = child;
      },
    });
    send({ type: 'result', jobId: request.jobId, result });
  } finally {
    busy = false;
    if (shuttingDown) {
      process.exit(shutdownExitCode);
    }
  }
}

function shutdown(exitCode = 0): void {
  if (shuttingDown) {
    shutdownExitCode = Math.max(shutdownExitCode, exitCode);
    return;
  }
  shutdownExitCode = exitCode;
  shuttingDown = true;
  ready = false;
  activeNativeProcess?.kill('SIGKILL');
  if (!initializing && !busy) {
    process.exit(shutdownExitCode);
  }
}

async function initialize(): Promise<void> {
  const result = await probeNativeTesseract({
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
    process.exit(shutdownExitCode);
  }
  if (!result.ok) {
    process.exit(1);
  }
  ready = true;
  send({ type: 'ready' });
}

process.on('message', (request: unknown) => {
  if (!isNativeTesseractWorkerRequest(request, { maxImageBytes, maxTimeoutMs })) {
    shutdown(1);
    return;
  }
  if (request.type === 'shutdown') {
    shutdown();
    return;
  }
  void handleRecognize(request);
});
process.once('disconnect', () => shutdown());
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());

void initialize().catch(() => process.exit(1));

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
