import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  NATIVE_TESSERACT_PAGE_SEGMENTATION_MODES,
  type NativeTesseractFailedOpenResult,
  type NativeTesseractFailureReason,
  type NativeTesseractOcrResult,
  type NativeTesseractPageSegmentationMode,
  type NativeTesseractRecognizeOptions,
} from './native-tesseract-ocr.types';
import type {
  NativeTesseractWorkerRequest,
  NativeTesseractWorkerResponse,
  NativeTesseractWorkerResultResponse,
} from './native-tesseract-worker.protocol';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_QUEUE = 16;
const DEFAULT_RECYCLE_AFTER_JOBS = 250;
const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_OMP_THREAD_LIMIT = 1;
const DEFAULT_PSM: NativeTesseractPageSegmentationMode = 11;
const WORKER_RESTART_DELAY_MS = 100;
const WORKER_RETRY_COOLDOWN_MS = 30_000;
const WORKER_SHUTDOWN_GRACE_MS = 1_000;
const WORKER_STARTUP_TIMEOUT_MS = 5_000;
const MAX_WORKER_RESTART_ATTEMPTS = 3;
const MAX_CONCURRENCY = 8;
const MAX_QUEUE = 256;

type OcrJob = {
  id: string;
  image: Buffer;
  psm: NativeTesseractPageSegmentationMode;
  passLabel: string;
  startedAt: number;
  deadlineAt: number;
  timer: NodeJS.Timeout;
  settled: boolean;
  resolve: (result: NativeTesseractOcrResult) => void;
};

type WorkerSlot = {
  id: number;
  generation: number;
  process: ChildProcess | null;
  ready: boolean;
  retiring: boolean;
  restartAttempts: number;
  retryAfter: number;
  jobsProcessed: number;
  current: OcrJob | null;
  restartTimer: NodeJS.Timeout | null;
  startupTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
};

@Injectable()
export class NativeTesseractOcrAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NativeTesseractOcrAdapter.name);
  private readonly binary: string;
  private readonly tessdataPrefix?: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly recycleAfterJobs: number;
  private readonly maxImageBytes: number;
  private readonly maxOutputBytes: number;
  private readonly ompThreadLimit: number;
  private readonly workerPath = resolveWorkerPath(__dirname);
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: OcrJob[] = [];
  private initialized = false;
  private shuttingDown = false;

  constructor(configService: ConfigService) {
    this.binary = readCommand(
      configService.get<string>('COMMERCIAL_OCR_TESSERACT_BINARY'),
      'tesseract',
    );
    this.tessdataPrefix = readOptionalPath(
      configService.get<string>('COMMERCIAL_OCR_TESSDATA_PREFIX'),
    );
    this.timeoutMs = readBoundedPositiveInteger(
      configService.get('COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS'),
      DEFAULT_TIMEOUT_MS,
      250,
      60_000,
    );
    this.concurrency = readBoundedPositiveInteger(
      configService.get('COMMERCIAL_OCR_TESSERACT_CONCURRENCY'),
      DEFAULT_CONCURRENCY,
      1,
      MAX_CONCURRENCY,
    );
    this.maxQueue = readBoundedPositiveInteger(
      configService.get('COMMERCIAL_OCR_TESSERACT_MAX_QUEUE'),
      DEFAULT_MAX_QUEUE,
      1,
      MAX_QUEUE,
    );
    this.recycleAfterJobs = readBoundedPositiveInteger(
      configService.get('COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS'),
      DEFAULT_RECYCLE_AFTER_JOBS,
      1,
      10_000,
    );
    this.maxImageBytes = readBoundedPositiveInteger(
      configService.get('COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES'),
      DEFAULT_MAX_IMAGE_BYTES,
      1_024,
      64 * 1024 * 1024,
    );
    this.maxOutputBytes = readBoundedPositiveInteger(
      configService.get('COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES'),
      DEFAULT_MAX_OUTPUT_BYTES,
      64 * 1024,
      16 * 1024 * 1024,
    );
    this.ompThreadLimit = readBoundedPositiveInteger(
      configService.get('OMP_THREAD_LIMIT'),
      DEFAULT_OMP_THREAD_LIMIT,
      1,
      MAX_CONCURRENCY,
    );
  }

  onModuleInit(): void {
    this.ensureInitialized();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    for (const job of this.queue.splice(0)) {
      this.finishJob(job, this.failedOpen(job, 'shutting_down'));
    }

    const exitPromises: Promise<void>[] = [];
    for (const slot of this.slots) {
      if (slot.restartTimer) {
        clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      clearSlotTimer(slot, 'startupTimer');
      clearSlotTimer(slot, 'killTimer');
      if (slot.current) {
        this.finishJob(slot.current, this.failedOpen(slot.current, 'shutting_down'));
        slot.current = null;
      }
      const child = slot.process;
      if (!child) {
        continue;
      }
      exitPromises.push(waitForExit(child));
      slot.retiring = true;
      this.sendToWorker(child, { type: 'shutdown' });
      child.kill('SIGTERM');
    }

    await Promise.race([
      Promise.allSettled(exitPromises),
      new Promise<void>((resolvePromise) => {
        const timeout = setTimeout(resolvePromise, WORKER_SHUTDOWN_GRACE_MS);
        timeout.unref();
      }),
    ]);
    for (const slot of this.slots) {
      if (slot.process && slot.process.exitCode === null && slot.process.signalCode === null) {
        slot.process.kill('SIGKILL');
      }
      slot.process = null;
      slot.ready = false;
    }
  }

  recognize(
    image: Buffer,
    options: NativeTesseractRecognizeOptions = {},
  ): Promise<NativeTesseractOcrResult> {
    const startedAt = performance.now();
    const psm = options.psm ?? DEFAULT_PSM;
    const passLabel = normalizePassLabel(options.passLabel);
    if (
      !Buffer.isBuffer(image) ||
      image.byteLength === 0 ||
      image.byteLength > this.maxImageBytes ||
      !isAllowedPsm(psm) ||
      passLabel === null
    ) {
      return Promise.resolve({
        ok: false,
        status: 'failed_open',
        passLabel: passLabel ?? 'invalid',
        psm: isAllowedPsm(psm) ? psm : DEFAULT_PSM,
        reason: 'invalid_input',
        durationMs: elapsedMs(startedAt),
      });
    }
    if (this.shuttingDown) {
      return Promise.resolve({
        ok: false,
        status: 'failed_open',
        passLabel,
        psm,
        reason: 'shutting_down',
        durationMs: elapsedMs(startedAt),
      });
    }

    this.ensureInitialized();
    this.retryUnavailableWorkers();
    const hasLiveWorker = this.slots.some((slot) => slot.process !== null);
    if (!hasLiveWorker) {
      return Promise.resolve({
        ok: false,
        status: 'failed_open',
        passLabel,
        psm,
        reason: 'worker_unavailable',
        durationMs: elapsedMs(startedAt),
      });
    }
    if (
      !this.slots.some((slot) => slot.ready && !slot.current) &&
      this.queue.length >= this.maxQueue
    ) {
      return Promise.resolve({
        ok: false,
        status: 'failed_open',
        passLabel,
        psm,
        reason: 'capacity_exhausted',
        durationMs: elapsedMs(startedAt),
      });
    }

    return new Promise<NativeTesseractOcrResult>((resolvePromise) => {
      const deadlineAt = performance.now() + this.timeoutMs;
      const job: OcrJob = {
        id: randomUUID(),
        image: Buffer.from(image),
        psm,
        passLabel,
        startedAt,
        deadlineAt,
        settled: false,
        resolve: resolvePromise,
        timer: setTimeout(() => this.handleJobTimeout(job), this.timeoutMs),
      };
      job.timer.unref();
      this.queue.push(job);
      this.dispatch();
    });
  }

  private ensureInitialized(): void {
    if (this.initialized || this.shuttingDown) {
      return;
    }
    this.initialized = true;
    for (let id = 0; id < this.concurrency; id += 1) {
      const slot: WorkerSlot = {
        id,
        generation: 0,
        process: null,
        ready: false,
        retiring: false,
        restartAttempts: 0,
        retryAfter: 0,
        jobsProcessed: 0,
        current: null,
        restartTimer: null,
        startupTimer: null,
        killTimer: null,
      };
      this.slots.push(slot);
      this.startWorker(slot);
    }
  }

  private startWorker(slot: WorkerSlot): void {
    if (this.shuttingDown || slot.process) {
      return;
    }
    slot.generation += 1;
    const generation = slot.generation;
    slot.ready = false;
    slot.retiring = false;
    slot.jobsProcessed = 0;

    let child: ChildProcess;
    try {
      child = this.forkWorker(this.workerPath, {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        env: workerEnvironment(
          this.binary,
          this.tessdataPrefix,
          this.maxOutputBytes,
          this.ompThreadLimit,
        ),
      });
    } catch {
      slot.restartAttempts += 1;
      if (slot.restartAttempts > MAX_WORKER_RESTART_ATTEMPTS) {
        slot.retryAfter = performance.now() + WORKER_RETRY_COOLDOWN_MS;
        this.failQueuedIfNoWorkers();
      } else {
        this.scheduleWorkerRestart(slot, WORKER_RESTART_DELAY_MS);
      }
      return;
    }
    slot.process = child;
    slot.startupTimer = setTimeout(() => {
      if (slot.process === child && !slot.ready) {
        this.failAndRestartWorker(slot, 'worker_unavailable');
      }
    }, WORKER_STARTUP_TIMEOUT_MS);
    slot.startupTimer.unref();
    child.on('message', (message: unknown) => this.handleWorkerMessage(slot, generation, message));
    child.once('error', () => this.handleWorkerExit(slot, generation, child, false));
    child.once('exit', () => this.handleWorkerExit(slot, generation, child, slot.retiring));
  }

  private handleWorkerMessage(slot: WorkerSlot, generation: number, message: unknown): void {
    if (generation !== slot.generation || !slot.process || !isWorkerResponse(message)) {
      if (generation === slot.generation && slot.process) {
        this.failAndRestartWorker(slot, 'invalid_output');
      }
      return;
    }
    if (message.type === 'ready') {
      clearSlotTimer(slot, 'startupTimer');
      slot.ready = true;
      slot.restartAttempts = 0;
      this.dispatch();
      return;
    }

    const job = slot.current;
    if (!job || message.jobId !== job.id) {
      this.failAndRestartWorker(slot, 'invalid_output');
      return;
    }
    slot.current = null;
    slot.jobsProcessed += 1;
    if (message.result.ok) {
      const payload = message.result.payload;
      if (!isWorkerPayload(payload)) {
        this.finishJob(job, this.failedOpen(job, 'invalid_output'));
        this.retireWorker(slot, true);
        this.dispatch();
        return;
      }
      this.finishJob(job, {
        ok: true,
        status: payload.text.length > 0 ? 'recognized' : 'no_text',
        passLabel: job.passLabel,
        psm: job.psm,
        ...payload,
        durationMs: elapsedMs(job.startedAt),
      });
    } else {
      this.finishJob(job, this.failedOpen(job, message.result.reason));
    }

    if (slot.jobsProcessed >= this.recycleAfterJobs) {
      this.retireWorker(slot);
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (this.shuttingDown) {
      return;
    }
    for (const slot of this.slots) {
      if (!slot.process || !slot.ready || slot.current || slot.retiring) {
        continue;
      }
      let job = this.queue.shift();
      while (job?.settled) {
        job = this.queue.shift();
      }
      if (!job) {
        return;
      }
      const remainingMs = Math.max(1, Math.floor(job.deadlineAt - performance.now()));
      slot.current = job;
      this.sendToWorker(
        slot.process,
        {
          type: 'recognize',
          jobId: job.id,
          image: job.image,
          psm: job.psm,
          timeoutMs: remainingMs,
        },
        (error) => {
          if (error && slot.current === job) {
            this.failAndRestartWorker(slot, 'worker_unavailable');
          }
        },
      );
    }
  }

  private handleJobTimeout(job: OcrJob): void {
    if (job.settled) {
      return;
    }
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.finishJob(job, this.failedOpen(job, 'timeout'));
      return;
    }
    const slot = this.slots.find((candidate) => candidate.current === job);
    if (slot) {
      this.finishJob(job, this.failedOpen(job, 'timeout'));
      slot.current = null;
      this.retireWorker(slot, true);
      this.dispatch();
    }
  }

  private failAndRestartWorker(slot: WorkerSlot, reason: NativeTesseractFailureReason): void {
    if (slot.current) {
      this.finishJob(slot.current, this.failedOpen(slot.current, reason));
      slot.current = null;
    }
    this.retireWorker(slot, true);
    this.dispatch();
  }

  private retireWorker(slot: WorkerSlot, force = false): void {
    const child = slot.process;
    if (!child || slot.retiring) {
      return;
    }
    slot.retiring = true;
    slot.ready = false;
    clearSlotTimer(slot, 'startupTimer');
    this.sendToWorker(child, { type: 'shutdown' });
    child.kill('SIGTERM');
    slot.killTimer = setTimeout(
      () => {
        if (slot.process === child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      },
      force ? 250 : WORKER_SHUTDOWN_GRACE_MS,
    );
    slot.killTimer.unref();
  }

  private handleWorkerExit(
    slot: WorkerSlot,
    generation: number,
    child: ChildProcess,
    intentional: boolean,
  ): void {
    if (generation !== slot.generation || slot.process !== child) {
      return;
    }
    const wasReady = slot.ready;
    slot.process = null;
    clearSlotTimer(slot, 'startupTimer');
    clearSlotTimer(slot, 'killTimer');
    slot.ready = false;
    slot.retiring = false;
    if (slot.current) {
      this.finishJob(slot.current, this.failedOpen(slot.current, 'worker_unavailable'));
      slot.current = null;
    }
    if (this.shuttingDown) {
      return;
    }

    if (!intentional) {
      slot.restartAttempts += 1;
    }
    if (!intentional && !wasReady && slot.restartAttempts > MAX_WORKER_RESTART_ATTEMPTS) {
      slot.retryAfter = performance.now() + WORKER_RETRY_COOLDOWN_MS;
      this.failQueuedIfNoWorkers();
      return;
    }
    this.scheduleWorkerRestart(slot, intentional ? 0 : WORKER_RESTART_DELAY_MS);
  }

  private scheduleWorkerRestart(slot: WorkerSlot, delayMs: number): void {
    if (slot.restartTimer || this.shuttingDown) {
      return;
    }
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      this.startWorker(slot);
    }, delayMs);
    slot.restartTimer.unref();
  }

  private retryUnavailableWorkers(): void {
    const now = performance.now();
    for (const slot of this.slots) {
      if (!slot.process && !slot.restartTimer && slot.retryAfter <= now) {
        slot.restartAttempts = 0;
        slot.retryAfter = 0;
        this.startWorker(slot);
      }
    }
  }

  private failQueuedIfNoWorkers(): void {
    if (this.slots.some((slot) => slot.process || slot.restartTimer)) {
      return;
    }
    for (const job of this.queue.splice(0)) {
      this.finishJob(job, this.failedOpen(job, 'worker_unavailable'));
    }
  }

  private finishJob(job: OcrJob, result: NativeTesseractOcrResult): void {
    if (job.settled) {
      return;
    }
    job.settled = true;
    clearTimeout(job.timer);
    job.image = Buffer.alloc(0);
    job.resolve(result);
  }

  private failedOpen(
    job: OcrJob,
    reason: NativeTesseractFailureReason,
  ): NativeTesseractFailedOpenResult {
    this.logger.debug(`Native Tesseract pass failed open: ${reason}`);
    return {
      ok: false,
      status: 'failed_open',
      passLabel: job.passLabel,
      psm: job.psm,
      reason,
      durationMs: elapsedMs(job.startedAt),
    };
  }

  private sendToWorker(
    child: ChildProcess,
    request: NativeTesseractWorkerRequest,
    callback?: (error: Error | null) => void,
  ): void {
    if (!child.connected) {
      callback?.(new Error('Tesseract worker IPC is disconnected'));
      return;
    }
    try {
      child.send(request, callback);
    } catch (error: unknown) {
      callback?.(error instanceof Error ? error : new Error('Tesseract worker IPC failed'));
    }
  }

  protected forkWorker(path: string, options: Parameters<typeof fork>[2]): ChildProcess {
    return fork(path, [], options);
  }
}

function isAllowedPsm(value: unknown): value is NativeTesseractPageSegmentationMode {
  return (NATIVE_TESSERACT_PAGE_SEGMENTATION_MODES as readonly unknown[]).includes(value);
}

function normalizePassLabel(value: string | undefined): string | null {
  const normalized = (value ?? 'primary').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(normalized) ? normalized : null;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function readBoundedPositiveInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

function readCommand(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length <= 1_024 && !normalized.includes('\0')
    ? normalized
    : fallback;
}

function readOptionalPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= 4_096 && !normalized.includes('\0')
    ? normalized
    : undefined;
}

function workerEnvironment(
  binary: string,
  tessdataPrefix: string | undefined,
  maxOutputBytes: number,
  ompThreadLimit: number,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    NODE_ENV: process.env.NODE_ENV,
    OMP_THREAD_LIMIT: String(ompThreadLimit),
    COMMERCIAL_OCR_TESSERACT_BINARY: binary,
    COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: String(maxOutputBytes),
    ...(tessdataPrefix ? { COMMERCIAL_OCR_TESSDATA_PREFIX: tessdataPrefix } : {}),
  };
}

function isWorkerResponse(value: unknown): value is NativeTesseractWorkerResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<NativeTesseractWorkerResponse>;
  if (candidate.type === 'ready') {
    return true;
  }
  if (candidate.type !== 'result') {
    return false;
  }
  const resultMessage = candidate as Partial<NativeTesseractWorkerResultResponse>;
  if (
    typeof resultMessage.jobId !== 'string' ||
    !resultMessage.result ||
    typeof resultMessage.result !== 'object'
  ) {
    return false;
  }
  if (resultMessage.result.ok === true) {
    return 'payload' in resultMessage.result;
  }
  return (
    resultMessage.result.ok === false &&
    isWorkerFailureReason((resultMessage.result as { reason?: unknown }).reason)
  );
}

function isWorkerFailureReason(value: unknown): boolean {
  return (
    value === 'timeout' ||
    value === 'tesseract_failed' ||
    value === 'output_limit' ||
    value === 'invalid_output'
  );
}

function isWorkerPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length <= 8_000 &&
    (candidate.aggregateConfidence === null || isConfidence(candidate.aggregateConfidence)) &&
    Array.isArray(candidate.words) &&
    Array.isArray(candidate.lines) &&
    typeof candidate.truncated === 'boolean' &&
    candidate.words.every(isWordSpan) &&
    candidate.lines.every(isLineSpan)
  );
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isWordSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length > 0 &&
    isNonNegativeInteger(candidate.start) &&
    isNonNegativeInteger(candidate.end) &&
    candidate.end >= candidate.start &&
    isConfidence(candidate.confidence) &&
    isNonNegativeInteger(candidate.lineIndex) &&
    isBoundingBox(candidate.boundingBox)
  );
}

function isLineSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length > 0 &&
    isNonNegativeInteger(candidate.start) &&
    isNonNegativeInteger(candidate.end) &&
    candidate.end >= candidate.start &&
    isConfidence(candidate.confidence) &&
    isNonNegativeInteger(candidate.wordStartIndex) &&
    isNonNegativeInteger(candidate.wordEndIndex) &&
    candidate.wordEndIndex >= candidate.wordStartIndex &&
    isBoundingBox(candidate.boundingBox)
  );
}

function isBoundingBox(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(candidate.left) &&
    isNonNegativeInteger(candidate.top) &&
    isNonNegativeInteger(candidate.width) &&
    isNonNegativeInteger(candidate.height) &&
    candidate.width > 0 &&
    candidate.height > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function resolveWorkerPath(directory: string): string {
  const compiled = resolve(directory, 'native-tesseract-worker.js');
  return existsSync(compiled) ? compiled : resolve(directory, 'native-tesseract-worker.ts');
}

function clearSlotTimer(slot: WorkerSlot, field: 'startupTimer' | 'killTimer'): void {
  const timer = slot[field];
  if (timer) {
    clearTimeout(timer);
    slot[field] = null;
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => child.once('exit', () => resolvePromise()));
}
