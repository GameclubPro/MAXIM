import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

import { COMMERCIAL_OCR_NATIVE_ORCHESTRATION } from './commercial-ocr-behavior-identity';
import { parseNativeTesseractTsv, type ParsedNativeTesseractTsv } from './native-tesseract-tsv';
import type { NativeTesseractPageSegmentationMode } from './native-tesseract-ocr.types';

const MAX_STDERR_BYTES = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.nativeStderrCaptureMaxBytes;
const POST_KILL_SETTLE_GRACE_MS =
  COMMERCIAL_OCR_NATIVE_ORCHESTRATION.nativeProcessKillSettleGraceMs;
const REQUIRED_TESSERACT_LANGUAGES = ['rus', 'eng'] as const;
const NATIVE_TESSERACT_INHERITED_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LD_LIBRARY_PATH',
  'NODE_ENV',
] as const;

export type NativeTesseractRunFailureReason =
  | 'timeout'
  | 'tesseract_failed'
  | 'output_limit'
  | 'invalid_output';

export type NativeTesseractRunResult =
  | { ok: true; payload: ParsedNativeTesseractTsv }
  | { ok: false; reason: NativeTesseractRunFailureReason };

export type NativeTesseractProbeFailureReason =
  | 'timeout'
  | 'tesseract_failed'
  | 'output_limit'
  | 'missing_languages';

export type NativeTesseractProbeResult =
  | { ok: true }
  | { ok: false; reason: NativeTesseractProbeFailureReason };

export type NativeTesseractRunOptions = {
  binary: string;
  image: Buffer;
  psm: NativeTesseractPageSegmentationMode;
  timeoutMs: number;
  maxOutputBytes: number;
  ompThreadLimit?: number;
  tessdataPrefix?: string;
  onProcessChange?: (process: ChildProcessWithoutNullStreams | null) => void;
};

export type NativeTesseractProbeOptions = {
  binary: string;
  timeoutMs: number;
  maxOutputBytes: number;
  tessdataPrefix?: string;
  onProcessChange?: (process: ChildProcessWithoutNullStreams | null) => void;
};

export type NativeTesseractSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export async function probeNativeTesseract(
  options: NativeTesseractProbeOptions,
  spawnProcess: NativeTesseractSpawn = spawn,
): Promise<NativeTesseractProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(options.binary, ['--list-langs'], {
        shell: false,
        windowsHide: true,
        env: nativeTesseractEnvironment({ tessdataPrefix: options.tessdataPrefix }),
      });
      options.onProcessChange?.(child);
    } catch {
      resolve({ ok: false, reason: 'tesseract_failed' });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedReason: NativeTesseractProbeFailureReason | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const onStdout = (chunk: Buffer | string) => {
      if (forcedReason) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        stop('output_limit');
        return;
      }
      stdoutChunks.push(buffer);
    };
    const onStderr = (chunk: Buffer | string) => {
      if (forcedReason) return;
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      if (stderrBytes > options.maxOutputBytes) stop('output_limit');
    };
    const onError = () => finish({ ok: false, reason: forcedReason ?? 'tesseract_failed' });
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (forcedReason) {
        finish({ ok: false, reason: forcedReason }, true);
        return;
      }
      if (code !== 0 || signal) {
        finish({ ok: false, reason: 'tesseract_failed' }, true);
        return;
      }
      const languages = new Set(
        Buffer.concat(stdoutChunks, stdoutBytes)
          .toString('utf8')
          .split(/\r?\n/u)
          .map((line) => line.trim()),
      );
      finish(
        REQUIRED_TESSERACT_LANGUAGES.every((language) => languages.has(language))
          ? { ok: true }
          : { ok: false, reason: 'missing_languages' },
        true,
      );
    };
    const onStdinError = () => undefined;
    const cleanup = (processClosed: boolean) => {
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdin.removeListener('error', onStdinError);
      if (!processClosed) {
        retainLateProcessErrorGuards(child, () => options.onProcessChange?.(null));
      }
    };

    const finish = (result: NativeTesseractProbeResult, processClosed = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      cleanup(processClosed);
      if (processClosed) options.onProcessChange?.(null);
      resolve(result);
    };
    const stop = (reason: NativeTesseractProbeFailureReason) => {
      if (settled || forcedReason) {
        return;
      }
      forcedReason = reason;
      try {
        child.kill('SIGKILL');
      } catch {
        finish({ ok: false, reason });
        return;
      }
      if (settled) return;
      forceSettleTimer = setTimeout(() => finish({ ok: false, reason }), POST_KILL_SETTLE_GRACE_MS);
      forceSettleTimer.unref();
    };

    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    child.stdin.once('error', onStdinError);
    child.stdin.end();
  });
}

export async function runNativeTesseract(
  options: NativeTesseractRunOptions,
  spawnProcess: NativeTesseractSpawn = spawn,
): Promise<NativeTesseractRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(
        options.binary,
        ['stdin', 'stdout', '-l', 'rus+eng', '--oem', '1', '--psm', String(options.psm), 'tsv'],
        {
          shell: false,
          windowsHide: true,
          env: nativeTesseractEnvironment({
            tessdataPrefix: options.tessdataPrefix,
            ompThreadLimit: options.ompThreadLimit,
          }),
        },
      );
      options.onProcessChange?.(child);
    } catch {
      resolve({ ok: false, reason: 'tesseract_failed' });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedReason: NativeTesseractRunFailureReason | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const onStdout = (chunk: Buffer | string) => {
      if (forcedReason) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        stop('output_limit');
        return;
      }
      stdoutChunks.push(buffer);
    };
    const onStderr = (chunk: Buffer | string) => {
      stderrBytes = Math.min(
        MAX_STDERR_BYTES,
        stderrBytes + (Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)),
      );
    };
    const onError = () => finish({ ok: false, reason: forcedReason ?? 'tesseract_failed' });
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (forcedReason) {
        finish({ ok: false, reason: forcedReason }, true);
        return;
      }
      if (code !== 0 || signal) {
        finish({ ok: false, reason: 'tesseract_failed' }, true);
        return;
      }
      try {
        finish(
          {
            ok: true,
            payload: parseNativeTesseractTsv(
              Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
            ),
          },
          true,
        );
      } catch {
        finish({ ok: false, reason: 'invalid_output' }, true);
      }
    };
    const onStdinError = () => undefined;
    const cleanup = (processClosed: boolean) => {
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdin.removeListener('error', onStdinError);
      if (!processClosed) {
        retainLateProcessErrorGuards(child, () => options.onProcessChange?.(null));
      }
    };

    const finish = (result: NativeTesseractRunResult, processClosed = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      cleanup(processClosed);
      if (processClosed) options.onProcessChange?.(null);
      resolve(result);
    };
    const stop = (reason: NativeTesseractRunFailureReason) => {
      if (settled || forcedReason) {
        return;
      }
      forcedReason = reason;
      try {
        child.kill('SIGKILL');
      } catch {
        finish({ ok: false, reason });
        return;
      }
      if (settled) return;
      forceSettleTimer = setTimeout(() => finish({ ok: false, reason }), POST_KILL_SETTLE_GRACE_MS);
      forceSettleTimer.unref();
    };

    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    child.stdin.once('error', onStdinError);
    child.stdin.end(options.image);
  });
}

function nativeTesseractEnvironment(options: {
  tessdataPrefix: string | undefined;
  ompThreadLimit?: number | undefined;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of NATIVE_TESSERACT_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  if (options.tessdataPrefix) {
    environment.TESSDATA_PREFIX = options.tessdataPrefix;
  }
  if (isOmpThreadLimit(options.ompThreadLimit)) {
    environment.OMP_THREAD_LIMIT = String(options.ompThreadLimit);
  }
  return environment;
}

function isOmpThreadLimit(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 1 && value <= 8;
}

function retainLateProcessErrorGuards(
  child: ChildProcessWithoutNullStreams,
  onCloseConfirmed: () => void,
): void {
  const onLateError = () => undefined;
  const onLateClose = () => {
    child.removeListener('error', onLateError);
    child.removeListener('close', onLateClose);
    child.stdin.removeListener('error', onLateError);
    child.stdout.removeListener('error', onLateError);
    child.stderr.removeListener('error', onLateError);
    onCloseConfirmed();
  };

  child.on('error', onLateError);
  child.once('close', onLateClose);
  child.stdin.on('error', onLateError);
  child.stdout.on('error', onLateError);
  child.stderr.on('error', onLateError);
}
