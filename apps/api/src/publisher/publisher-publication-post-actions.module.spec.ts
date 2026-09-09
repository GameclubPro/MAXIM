import { MODULE_METADATA } from '@nestjs/common/constants';

describe('Publisher post-action runtime wiring', () => {
  it('imports the non-global governor module and registers the worker only for Publisher', async () => {
    const previousRole = process.env.APP_ROLE;
    try {
      for (const role of ['publisher', 'admin']) {
        process.env.APP_ROLE = role;
        await jest.isolateModulesAsync(async () => {
          const { PublisherModule } = await import('./publisher.module');
          const { SystemModule } = await import('../system/system.module');
          const { BackgroundRuntimeGovernorService } =
            await import('../system/background-runtime-governor.service');
          const { PublisherPublicationPostActionsService } =
            await import('./publisher-publication-post-actions.service');
          const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, PublisherModule);
          const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PublisherModule);
          expect(imports).toContain(SystemModule);
          expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, SystemModule)).toContain(
            BackgroundRuntimeGovernorService,
          );
          expect(providers.includes(PublisherPublicationPostActionsService)).toBe(
            role === 'publisher',
          );
        });
      }
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
  });
});
