import { MODULE_METADATA } from '@nestjs/common/constants';

describe('message duplicate runtime ownership', () => {
  it.each([
    'api-admin',
    'api-moderation',
    'api-moderation-background',
    'api-media-analysis',
    'api-action',
  ])('registers heavy analysis only in background, not %s', async (serviceName) => {
    const previous = {
      APP_ROLE: process.env.APP_ROLE,
      APP_SERVICE_NAME: process.env.APP_SERVICE_NAME,
      MODERATION_ENABLED_QUEUES: process.env.MODERATION_ENABLED_QUEUES,
    };
    process.env.APP_ROLE =
      serviceName === 'api-admin'
        ? 'admin'
        : serviceName === 'api-action'
          ? 'action'
          : 'moderation';
    process.env.APP_SERVICE_NAME = serviceName;
    delete process.env.MODERATION_ENABLED_QUEUES;
    jest.resetModules();
    try {
      const { ModerationModule } = await import('../moderation.module');
      const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ModerationModule) as {
        name?: string;
      }[];
      expect(providers.some((provider) => provider.name === 'MessageDuplicateProcessor')).toBe(
        serviceName === 'api-moderation-background',
      );
      expect(providers.some((provider) => provider.name === 'MessageDuplicateMediaService')).toBe(
        serviceName === 'api-moderation-background',
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.resetModules();
    }
  });
});
