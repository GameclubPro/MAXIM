import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  NativeOcrSandboxClient,
  NativeOcrSandboxImageRejectedError,
  NativeOcrSandboxUnavailableError,
} from './native-ocr-sandbox.client';
import {
  COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  CommercialOcrImageRejectedError,
  resolveCommercialOcrPreprocessLimits,
  type CommercialOcrPassName,
  type CommercialOcrPreparedImage,
} from './commercial-ocr-preprocess-config';
import { NATIVE_OCR_SANDBOX_IPC_GRACE_MS } from './native-ocr-sandbox.protocol';

const MINIMUM_SHARP_EXECUTION_BUDGET_MS = 1_000;

export {
  COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS,
  COMMERCIAL_OCR_PREPROCESS_PROFILES,
  COMMERCIAL_OCR_SHARP_CONCURRENCY,
  COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  CommercialOcrImageRejectedError,
  resolveCommercialOcrPreprocessCacheProfile,
  resolveCommercialOcrPreprocessLimits,
  type CommercialOcrPassName,
  type CommercialOcrPreparedImage,
  type CommercialOcrPreprocessConfigReader,
  type CommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocess-config';

export class CommercialOcrPreprocessUnavailableError extends Error {
  readonly retryable = true;

  constructor() {
    super('Commercial OCR native preprocess boundary is unavailable');
    this.name = 'CommercialOcrPreprocessUnavailableError';
  }
}

@Injectable()
export class CommercialOcrPreprocessor implements OnModuleDestroy {
  private readonly sandbox: NativeOcrSandboxClient;
  private readonly localEnabled: boolean;
  private localPromise: Promise<
    import('./native-ocr-image-preprocessor').NativeOcrImagePreprocessor
  > | null = null;

  constructor(configService: ConfigService) {
    const limits = resolveCommercialOcrPreprocessLimits(configService);
    this.sandbox = new NativeOcrSandboxClient(configService);
    this.localEnabled = !this.sandbox.isConfigured() && !this.sandbox.isRequired();
    if (this.localEnabled) {
      this.localPromise = import('./native-ocr-image-preprocessor').then(
        ({ NativeOcrImagePreprocessor }) => new NativeOcrImagePreprocessor(limits),
      );
    }
  }

  async prepare(
    input: Buffer,
    pass: CommercialOcrPassName,
    options: { deadlineAtMs?: number } = {},
  ): Promise<CommercialOcrPreparedImage> {
    if (this.sandbox.isConfigured()) {
      const timeoutMs = resolveSandboxPreprocessTimeout(options.deadlineAtMs);
      try {
        return await this.sandbox.preprocess(input, pass, timeoutMs);
      } catch (error: unknown) {
        if (error instanceof NativeOcrSandboxImageRejectedError) {
          throw new CommercialOcrImageRejectedError(error.reason);
        }
        if (error instanceof NativeOcrSandboxUnavailableError) {
          throw new CommercialOcrPreprocessUnavailableError();
        }
        throw error;
      }
    }
    if (!this.localEnabled || !this.localPromise) {
      throw new CommercialOcrPreprocessUnavailableError();
    }
    return (await this.localPromise).prepare(input, pass, options);
  }

  onModuleDestroy(): void {
    this.sandbox.close();
  }
}

function resolveSandboxPreprocessTimeout(deadlineAtMs: number | undefined): number {
  const localMaximumMs = COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS * 1_000;
  if (deadlineAtMs === undefined) {
    return localMaximumMs;
  }
  if (!Number.isSafeInteger(deadlineAtMs)) {
    throw new CommercialOcrImageRejectedError('processing_timeout');
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= NATIVE_OCR_SANDBOX_IPC_GRACE_MS + MINIMUM_SHARP_EXECUTION_BUDGET_MS) {
    throw new CommercialOcrImageRejectedError('processing_timeout');
  }
  return Math.min(localMaximumMs, remainingMs - NATIVE_OCR_SANDBOX_IPC_GRACE_MS);
}
