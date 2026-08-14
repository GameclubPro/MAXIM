import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getQueueToken } from '@nestjs/bullmq';

type CommercialOcrModuleProfile = Readonly<{
  admissionStore: boolean;
  producer: boolean;
  enqueueService: boolean;
  cacheStore: boolean;
  metricsService: boolean;
  metricsExport: boolean;
  processor: boolean;
  consumerQueue: boolean;
}>;

const PROFILE_ENV_KEYS = ['APP_ROLE', 'APP_SERVICE_NAME', 'MODERATION_ENABLED_QUEUES'] as const;

async function loadCommercialOcrModuleProfile(params: {
  appRole: 'all' | 'moderation';
  serviceName: 'api-all' | 'api-moderation' | 'api-media-analysis';
}): Promise<CommercialOcrModuleProfile> {
  const previousEnv = Object.fromEntries(
    PROFILE_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>;

  process.env.APP_ROLE = params.appRole;
  process.env.APP_SERVICE_NAME = params.serviceName;
  delete process.env.MODERATION_ENABLED_QUEUES;
  jest.resetModules();

  try {
    const { ModerationModule } = await import('./moderation.module');
    const [
      { CommercialOcrAdmissionStore },
      { CommercialOcrCacheStore },
      { CommercialOcrEnqueueService },
      { CommercialOcrMetricsService },
      { CommercialOcrQueueProducer },
      { CommercialOcrProcessor },
      { COMMERCIAL_OCR_QUEUE },
    ] = await Promise.all([
      import('./commercial-ocr/commercial-ocr-admission.store'),
      import('./commercial-ocr/commercial-ocr-cache.store'),
      import('./commercial-ocr/commercial-ocr-enqueue.service'),
      import('./commercial-ocr/commercial-ocr-metrics.service'),
      import('./commercial-ocr/commercial-ocr-queue.producer'),
      import('./commercial-ocr/commercial-ocr.processor'),
      import('./commercial-ocr/commercial-ocr.queue'),
    ]);
    const providers = readModuleMetadata(ModerationModule, MODULE_METADATA.PROVIDERS);
    const providerTokens = new Set(providers.map(readProviderToken));
    const imports = readModuleMetadata(ModerationModule, MODULE_METADATA.IMPORTS);
    const exports = new Set(
      readModuleMetadata(ModerationModule, MODULE_METADATA.EXPORTS).map(readProviderToken),
    );

    return {
      admissionStore: providerTokens.has(CommercialOcrAdmissionStore),
      producer: providerTokens.has(CommercialOcrQueueProducer),
      enqueueService: providerTokens.has(CommercialOcrEnqueueService),
      cacheStore: providerTokens.has(CommercialOcrCacheStore),
      metricsService: providerTokens.has(CommercialOcrMetricsService),
      metricsExport: exports.has(CommercialOcrMetricsService),
      processor: providerTokens.has(CommercialOcrProcessor),
      consumerQueue: imports.some((entry) =>
        dynamicModuleExportsToken(entry, getQueueToken(COMMERCIAL_OCR_QUEUE)),
      ),
    };
  } finally {
    for (const key of PROFILE_ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.resetModules();
  }
}

function readModuleMetadata(moduleType: unknown, key: string): unknown[] {
  return (Reflect.getMetadata(key, moduleType as object) as unknown[] | undefined) ?? [];
}

function readProviderToken(provider: unknown): unknown {
  return isRecord(provider) && 'provide' in provider ? provider.provide : provider;
}

function dynamicModuleExportsToken(moduleImport: unknown, token: string): boolean {
  if (!isRecord(moduleImport) || !Array.isArray(moduleImport.exports)) {
    return false;
  }
  return moduleImport.exports.some((exported: Provider) => readProviderToken(exported) === token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('ModerationModule commercial OCR runtime boundaries', () => {
  it('keeps producer and consumer dependencies isolated by runtime profile', async () => {
    const webhook = await loadCommercialOcrModuleProfile({
      appRole: 'moderation',
      serviceName: 'api-moderation',
    });
    const mediaAnalysis = await loadCommercialOcrModuleProfile({
      appRole: 'moderation',
      serviceName: 'api-media-analysis',
    });
    const allInOne = await loadCommercialOcrModuleProfile({
      appRole: 'all',
      serviceName: 'api-all',
    });

    expect(webhook).toEqual({
      admissionStore: true,
      producer: true,
      enqueueService: true,
      cacheStore: false,
      metricsService: true,
      metricsExport: true,
      processor: false,
      consumerQueue: false,
    });
    expect(mediaAnalysis).toEqual({
      admissionStore: true,
      producer: false,
      enqueueService: false,
      cacheStore: true,
      metricsService: true,
      metricsExport: true,
      processor: true,
      consumerQueue: true,
    });
    expect(allInOne).toEqual({
      admissionStore: true,
      producer: true,
      enqueueService: true,
      cacheStore: true,
      metricsService: true,
      metricsExport: true,
      processor: true,
      consumerQueue: true,
    });
  });
});
