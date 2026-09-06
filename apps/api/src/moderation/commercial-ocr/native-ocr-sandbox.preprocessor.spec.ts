import { ConfigService } from '@nestjs/config';

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
          retryable: true,
        }),
      );
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
