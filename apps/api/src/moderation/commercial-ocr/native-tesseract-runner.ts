import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

import { parseNativeTesseractTsv, type ParsedNativeTesseractTsv } from './native-tesseract-tsv';
import type { NativeTesseractPageSegmentationMode } from './native-tesseract-ocr.types';

const MAX_STDERR_BYTES = 64 * 1024;
const REQUIRED_TESSERACT_LANGUAGES = ['rus', 'eng'] as const;

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
        env: {
          ...process.env,
          ...(options.tessdataPrefix ? { TESSDATA_PREFIX: options.tessdataPrefix } : {}),
        },
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

    const finish = (result: NativeTesseractProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.onProcessChange?.(null);
      resolve(result);
    };
    const stop = (reason: NativeTesseractProbeFailureReason) => {
      if (settled || forcedReason) {
        return;
      }
      forcedReason = reason;
      child.kill('SIGKILL');
    };

    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (forcedReason) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        stop('output_limit');
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (forcedReason) {
        return;
      }
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      if (stderrBytes > options.maxOutputBytes) {
        stop('output_limit');
      }
    });
    child.once('error', () => finish({ ok: false, reason: forcedReason ?? 'tesseract_failed' }));
    child.once('close', (code, signal) => {
      if (forcedReason) {
        finish({ ok: false, reason: forcedReason });
        return;
      }
      if (code !== 0 || signal) {
        finish({ ok: false, reason: 'tesseract_failed' });
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
      );
    });

    child.stdin.once('error', () => {
      // A process exit is authoritative and will settle the probe through error/close.
    });
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
          env: {
            ...process.env,
            ...(options.tessdataPrefix ? { TESSDATA_PREFIX: options.tessdataPrefix } : {}),
          },
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

    const finish = (result: NativeTesseractRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.onProcessChange?.(null);
      resolve(result);
    };
    const stop = (reason: NativeTesseractRunFailureReason) => {
      if (settled || forcedReason) {
        return;
      }
      forcedReason = reason;
      child.kill('SIGKILL');
    };

    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (forcedReason) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        stop('output_limit');
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBytes = Math.min(
        MAX_STDERR_BYTES,
        stderrBytes + (Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)),
      );
    });
    child.once('error', () => finish({ ok: false, reason: forcedReason ?? 'tesseract_failed' }));
    child.once('close', (code, signal) => {
      if (forcedReason) {
        finish({ ok: false, reason: forcedReason });
        return;
      }
      if (code !== 0 || signal) {
        finish({ ok: false, reason: 'tesseract_failed' });
        return;
      }
      try {
        finish({
          ok: true,
          payload: parseNativeTesseractTsv(
            Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          ),
        });
      } catch {
        finish({ ok: false, reason: 'invalid_output' });
      }
    });

    child.stdin.once('error', () => {
      // A process exit is authoritative and will settle the run through error/close.
    });
    child.stdin.end(options.image);
  });
}
