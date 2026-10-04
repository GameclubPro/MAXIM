import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  nativeProcessGroupSpawnOptions,
  signalNativeProcessGroup,
  verifyNativeProcessGroupTeardown,
} from '../commercial-ocr/native-process-group';
import {
  encodePhotoFrame,
  parsePhotoResult,
  PHOTO_NATIVE_MAX_METADATA_BYTES,
  PHOTO_NATIVE_TEARDOWN_GRACE_MS,
  type NativePhotoRequest,
  type NativePhotoResult,
} from './native-photo-sandbox.protocol';

export class PhotoNativeContainmentError extends Error {}

export async function runNativePhotoWorker(
  request: NativePhotoRequest,
  payload: Buffer,
  signal: AbortSignal,
  options: { workerPath?: string; execArgv?: string[] } = {},
): Promise<NativePhotoResult> {
  if (signal.aborted || Date.now() >= request.deadlineAtMs)
    return { kind: 'rejected', reason: 'decode_deadline_exceeded' };
  const frame = encodePhotoFrame(request, payload);
  const child = spawn(
    process.execPath,
    [...(options.execArgv ?? []), options.workerPath ?? join(__dirname, 'native-photo-worker.js')],
    {
      ...nativeProcessGroupSpawnOptions(),
      stdio: ['pipe', 'pipe', 'ignore'],
      // FLAG: Never inherit API secrets, NODE_OPTIONS or a caller-selected executable/path.
      // This worker is spawned only by the no-network sandbox, not the API process.
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/home/node',
        LANG: 'C.UTF-8',
        NODE_ENV: 'production',
        VIPS_CONCURRENCY: '1',
      },
    },
  );
  let stopped = false;
  let failed = false;
  let outputBytes = 0;
  const chunks: Buffer[] = [];
  let rejectContainment: ((error: Error) => void) | undefined;
  let containmentTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signalNativeProcessGroup(child, 'SIGKILL', { requireIsolatedGroup: true });
    containmentTimer = setTimeout(
      () =>
        rejectContainment?.(
          new PhotoNativeContainmentError('Photo child did not close after termination'),
        ),
      PHOTO_NATIVE_TEARDOWN_GRACE_MS,
    );
  };
  const timer = setTimeout(stop, Math.max(1, request.deadlineAtMs - Date.now()));
  signal.addEventListener('abort', stop, { once: true });
  child.stdin.on('error', () => {
    failed = true;
    stop();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > PHOTO_NATIVE_MAX_METADATA_BYTES) {
      failed = true;
      stop();
      return;
    }
    chunks.push(chunk);
  });
  // FLAG: Do not release native capacity on a timer/Promise.race. 'close' reaps the
  // child; group verification additionally rejects surviving descendants.
  const code = await new Promise<number | null>((resolve, reject) => {
    rejectContainment = reject;
    child.once('error', () => {
      failed = true;
    });
    child.once('close', resolve);
    child.stdin.end(frame);
  });
  clearTimeout(timer);
  clearTimeout(containmentTimer);
  signal.removeEventListener('abort', stop);
  if (
    child.pid &&
    !(await verifyNativeProcessGroupTeardown(child, {
      graceMs: PHOTO_NATIVE_TEARDOWN_GRACE_MS,
      requireIsolatedGroup: true,
    }))
  ) {
    throw new PhotoNativeContainmentError('Photo native process group could not be reaped');
  }
  if (stopped && !failed) return { kind: 'rejected', reason: 'decode_deadline_exceeded' };
  if (failed || code !== 0) return { kind: 'rejected', reason: 'native_unavailable' };
  try {
    return parsePhotoResult(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return { kind: 'rejected', reason: 'native_unavailable' };
  }
}
