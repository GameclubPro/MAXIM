import { ConfigService } from '@nestjs/config';

import { NativeTesseractOcrAdapter } from './native-tesseract-ocr.adapter';

describe('NativeTesseractOcrAdapter production sandbox requirement', () => {
  it('fails closed without a configured Unix-socket boundary in api-media-analysis', async () => {
    const adapter = new NativeTesseractOcrAdapter(
      new ConfigService({
        NODE_ENV: 'production',
        APP_SERVICE_NAME: 'api-media-analysis',
        COMMERCIAL_OCR_TESSERACT_CONCURRENCY: 1,
      }),
    );
    adapter.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));

    try {
      expect(adapter.isSandboxBoundaryVerified()).toBe(false);
      expect(adapter.getRuntimeStatus()).toMatchObject({
        state: 'degraded',
        ready: false,
        workers: { live: 0, ready: 0 },
        boundary: {
          kind: 'local_worker',
          required: true,
          verified: false,
        },
      });
      await expect(adapter.recognize(Buffer.from('private image'))).resolves.toMatchObject({
        ok: false,
        status: 'failed_open',
        reason: 'artifact_unverified',
      });
    } finally {
      await adapter.onModuleDestroy();
    }
  });
});
