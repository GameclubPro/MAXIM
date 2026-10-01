import { ConfigService } from '@nestjs/config';
import {
  NativeOcrSandboxRequestError,
  NativeOcrSandboxRequestTimeoutError,
  NativeOcrSandboxUnavailableError,
} from './native-ocr-sandbox.client';

import {
  CommercialOcrPreprocessUnavailableError,
  CommercialOcrPreprocessor,
} from './commercial-ocr-preprocessor';

describe('CommercialOcrPreprocessor production sandbox requirement', () => {
  it('does not fall back to local Sharp when the media sandbox socket is missing', async () => {
    const preprocessor = new CommercialOcrPreprocessor(
      new ConfigService({
        NODE_ENV: 'production',
        APP_SERVICE_NAME: 'api-media-analysis',
      }),
    );

    try {
      await expect(preprocessor.prepare(Buffer.from('untrusted image'), 'primary')).rejects.toEqual(
        expect.objectContaining<Partial<CommercialOcrPreprocessUnavailableError>>({
          name: 'CommercialOcrPreprocessUnavailableError',
          retryable: false,
          reason: 'unconfigured',
        }),
      );
    } finally {
      preprocessor.onModuleDestroy();
    }
  });

  it.each([
    ['unavailable', true],
    ['unverified', false],
    ['invalid_response', false],
  ] as const)('preserves %s boundary failures and retry safety', async (reason, retryable) => {
    const preprocessor = new CommercialOcrPreprocessor(
      new ConfigService({ COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/tmp/native-ocr-test.sock' }),
    );
    jest
      .spyOn((preprocessor as any).sandbox, 'preprocess')
      .mockRejectedValueOnce(new NativeOcrSandboxUnavailableError(reason));
    try {
      await expect(preprocessor.prepare(Buffer.from('image'), 'primary')).rejects.toMatchObject({
        reason,
        retryable,
      });
    } finally {
      preprocessor.onModuleDestroy();
    }
  });

  it('preserves an uncertain active response timeout as terminal', async () => {
    const preprocessor = new CommercialOcrPreprocessor(
      new ConfigService({ COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/tmp/native-ocr-test.sock' }),
    );
    jest
      .spyOn((preprocessor as any).sandbox, 'preprocess')
      .mockRejectedValueOnce(new NativeOcrSandboxRequestTimeoutError());
    try {
      await expect(preprocessor.prepare(Buffer.from('image'), 'primary')).rejects.toMatchObject({
        reason: 'request_timeout',
        retryable: false,
      });
    } finally {
      preprocessor.onModuleDestroy();
    }
  });

  it('keeps valid request rejection separate from identity failure', async () => {
    const preprocessor = new CommercialOcrPreprocessor(
      new ConfigService({ COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/tmp/native-ocr-test.sock' }),
    );
    const mock = jest
      .spyOn((preprocessor as any).sandbox, 'preprocess')
      .mockRejectedValueOnce(new NativeOcrSandboxRequestError('capacity_exhausted'));
    const deadlineAtMs = Date.now() + 30_000;
    try {
      await expect(
        preprocessor.prepare(Buffer.from('image'), 'primary', { deadlineAtMs }),
      ).rejects.toMatchObject({ reason: 'capacity_exhausted', retryable: false });
      expect(mock).toHaveBeenCalledWith(expect.any(Buffer), 'primary', 5_000, { deadlineAtMs });
    } finally {
      preprocessor.onModuleDestroy();
    }
  });

  it('rejects an exhausted deadline before contacting or recycling the sandbox', async () => {
    const preprocessor = new CommercialOcrPreprocessor(
      new ConfigService({
        NODE_ENV: 'test',
        COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/tmp/native-ocr-test.sock',
      }),
    );
    const sandboxPreprocess = jest.fn();
    (
      preprocessor as unknown as {
        sandbox: { preprocess: typeof sandboxPreprocess };
      }
    ).sandbox.preprocess = sandboxPreprocess;

    try {
      await expect(
        preprocessor.prepare(Buffer.from('untrusted image'), 'primary', {
          deadlineAtMs: Date.now() + 1_400,
        }),
      ).rejects.toMatchObject({
        name: 'CommercialOcrImageRejectedError',
        reason: 'processing_timeout',
      });
      expect(sandboxPreprocess).not.toHaveBeenCalled();
    } finally {
      preprocessor.onModuleDestroy();
    }
  });
});
