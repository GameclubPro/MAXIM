import { ConfigService } from '@nestjs/config';

import {
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionNativeConfigReader,
} from '../moderation/commercial-ocr/commercial-ocr-behavior-identity';
import {
  assertCommercialOcrWorkerSmokeText,
  createCommercialOcrWorkerSmokeConfig,
} from './smoke-commercial-ocr-worker';

describe('assertCommercialOcrWorkerSmokeText', () => {
  const completeResult = 'РЕМОНТ КВАРТИР\nREPAIR SERVICE\nЗВОНИТЕ +7 (999) 123-45-67';

  it('requires Cyrillic, Latin, call-to-action, and phone recognition together', () => {
    expect(() => assertCommercialOcrWorkerSmokeText(completeResult)).not.toThrow();

    for (const incompleteResult of [
      'REPAIR SERVICE\nЗВОНИТЕ +7 (999) 123-45-67',
      'РЕМОНТ КВАРТИР\nЗВОНИТЕ +7 (999) 123-45-67',
      'РЕМОНТ КВАРТИР\nREPAIR SERVICE\n+7 (999) 123-45-67',
      'РЕМОНТ КВАРТИР\nREPAIR SERVICE\nЗВОНИТЕ +7 (999) 123-45-66',
    ]) {
      expect(() => assertCommercialOcrWorkerSmokeText(incompleteResult)).toThrow(
        'Commercial OCR worker smoke did not recognize the expected opaque fixture',
      );
    }
  });

  it('preserves the verified production native-control profile', () => {
    const environment = {
      APP_SERVICE_NAME: 'api-media-analysis',
      COMMERCIAL_OCR_TESSERACT_CONCURRENCY: '1',
      COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: '4',
      COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: '321',
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
      COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: String(3 * 1024 * 1024),
      COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: String(768 * 1024),
      OMP_THREAD_LIMIT: '1',
    } satisfies NodeJS.ProcessEnv;
    const smokeConfig = createCommercialOcrWorkerSmokeConfig(environment);
    const originalControls = resolveCommercialOcrNativeRuntimeControls(
      new ConfigService(environment),
    );

    expect(resolveCommercialOcrNativeRuntimeControls(smokeConfig)).toEqual(originalControls);
    expect(
      resolveCommercialOcrNativeRuntimeControls(
        resolveCommercialOcrProductionNativeConfigReader(smokeConfig),
      ),
    ).toEqual(originalControls);
  });
});
