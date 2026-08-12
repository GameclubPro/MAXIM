import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { probeNativeTesseract, runNativeTesseract } from './native-tesseract-runner';
import type {
  NativeTesseractWorkerRecognizeRequest,
  NativeTesseractWorkerRequest,
  NativeTesseractWorkerResponse,
} from './native-tesseract-worker.protocol';

const binary = process.env.COMMERCIAL_OCR_TESSERACT_BINARY?.trim() || 'tesseract';
const tessdataPrefix = process.env.COMMERCIAL_OCR_TESSDATA_PREFIX?.trim() || undefined;
const maxOutputBytes = readPositiveInteger(
  process.env.COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES,
  4 * 1024 * 1024,
);
const STARTUP_PROBE_TIMEOUT_MS = 4_000;
const STARTUP_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

let activeNativeProcess: ChildProcessWithoutNullStreams | null = null;
let initializing = true;
let ready = false;
let busy = false;
let shuttingDown = false;

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
      process.exit(0);
    }
  }
}

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  ready = false;
  activeNativeProcess?.kill('SIGKILL');
  if (!initializing && !busy) {
    process.exit(0);
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
    process.exit(0);
  }
  if (!result.ok) {
    process.exit(1);
  }
  ready = true;
  send({ type: 'ready' });
}

process.on('message', (request: NativeTesseractWorkerRequest) => {
  if (!request || typeof request !== 'object') {
    return;
  }
  if (request.type === 'shutdown') {
    shutdown();
    return;
  }
  if (request.type === 'recognize') {
    void handleRecognize(request);
  }
});
process.once('disconnect', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

void initialize().catch(() => process.exit(1));

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
