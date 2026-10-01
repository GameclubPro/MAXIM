import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import { MODULE_METADATA } from '@nestjs/common/constants';

jest.mock('ioredis', () => {
  class Redis {
    status = 'wait';
    on() {
      return this;
    }
    duplicate() {
      return new Redis();
    }
    defineCommand() {}
    disconnect() {}
    async quit() {
      return 'OK';
    }
    async set() {
      return 'OK';
    }
  }
  return { __esModule: true, default: Redis };
});

describe('retention root dependency graph', () => {
  it('resolves the real retention and guard providers without loading the full runtime root', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'production',
      APP_ROLE: 'message-retention',
      APP_SERVICE_NAME: 'api-message-retention',
      APP_BASE_URL: 'https://example.com',
      MAX_BOT_ID: 'test-bot',
      MAX_BOT_TOKEN: 'test-token-123',
      MAX_WEBHOOK_SECRET_PATH: 'test-secret-path-12345',
      MAX_WEBHOOK_HEADER_SECRET: 'test-header-secret-12345',
      ADMIN_ACCESS_CODE: 'test-owner-code-12345',
      DATABASE_URL: 'postgresql://maxim:maxim@localhost:5432/maxim',
      REDIS_URL: 'redis://localhost:6379',
    });
    try {
      await jest.isolateModulesAsync(async () => {
        const { Test } = await import('@nestjs/testing');
        const { loadRuntimeRootModule } = await import('./runtime-root-module');
        const root = await loadRuntimeRootModule('message-retention');
        const modules = new Set<unknown>();
        const providerNames = new Set<string>();
        const queueTokens = new Set<string>();
        function visit(value: unknown): void {
          if (!value || modules.has(value)) return;
          modules.add(value);
          const moduleClass =
            typeof value === 'function' ? value : (value as { module?: unknown }).module;
          if (!moduleClass) return;
          const dynamic = typeof value === 'function' ? {} : (value as Record<string, unknown[]>);
          for (const provider of [
            ...(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, moduleClass) ?? []),
            ...(dynamic.providers ?? []),
          ]) {
            if (typeof provider === 'function') providerNames.add(provider.name);
            else if (
              typeof provider?.provide === 'string' &&
              provider.provide.startsWith('BullQueue_')
            )
              queueTokens.add(provider.provide);
          }
          for (const dependency of [
            ...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) ?? []),
            ...(dynamic.imports ?? []),
          ])
            visit(dependency);
        }
        visit(root);
        expect(root.name).toBe('MessageRetentionAppModule');
        expect(providerNames.has('MessageRetentionRuntime')).toBe(true);
        expect(providerNames.has('ModerationDeleteIntentService')).toBe(true);
        expect(providerNames.has('MessageRetentionDeleteGuard')).toBe(true);
        expect(providerNames.has('MessageDuplicateDeleteGuardService')).toBe(true);
        expect(providerNames.has('ModerationService')).toBe(false);
        expect(providerNames.has('AdminService')).toBe(false);
        expect(providerNames.has('PublisherPostImportService')).toBe(false);
        expect(providerNames.has('SystemDashboardService')).toBe(false);
        expect(providerNames.has('SystemBotsService')).toBe(false);
        expect(providerNames.has('MiniappSessionService')).toBe(false);
        expect(providerNames.has('BackgroundRuntimeGovernorService')).toBe(true);
        expect(providerNames.has('MaxActionLedgerWatchdogService')).toBe(true);
        const { PrismaService } = await import('../prisma/prisma.service');
        const { MessageRetentionRuntime } =
          await import('../message-retention/message-retention-runtime.service');
        const { ModerationDeleteIntentService } =
          await import('../moderation/moderation-delete-intent.service');
        const builder = Test.createTestingModule({ imports: [root] })
          .overrideProvider(PrismaService)
          .useValue({});
        for (const token of queueTokens) builder.overrideProvider(token).useValue({});
        const context = await builder.compile();
        try {
          expect(context.get(MessageRetentionRuntime)).toBeInstanceOf(MessageRetentionRuntime);
          expect(context.get(ModerationDeleteIntentService)).toBeInstanceOf(
            ModerationDeleteIntentService,
          );
          expect(context.get(getQueueToken('message-retention'))).toEqual({});
        } finally {
          await context.close();
        }
      });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });
});
