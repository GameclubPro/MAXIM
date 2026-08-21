import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NIGHT_MODE_TRANSITION_QUEUE } from '../moderation/night-mode-transition.queue';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotModule } from './max-bot.module';
import { MaxBotOwnershipFoundationService } from './max-bot-ownership-foundation.service';
import { MaxBotRegistryService } from './max-bot-registry.service';

describe('MaxBotModule', () => {
  it('resolves the post-commit night mode scheduler with the shared bot registry', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              MAX_BOT_ID: 'bot-1',
              MAX_BOT_TOKEN: 'test-token',
              MAX_WEBHOOK_SECRET_PATH: 'test-webhook-path',
              MAX_WEBHOOK_HEADER_SECRET: 'test-webhook-secret',
              REDIS_URL: 'redis://127.0.0.1:63799',
            }),
          ],
        }),
        BullModule.forRoot({
          connection: {
            host: '127.0.0.1',
            port: 63_799,
          },
        }),
        MaxBotModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(MaxBotOwnershipFoundationService)
      .useValue({})
      .overrideProvider(RedisCounterService)
      .useValue({ getString: jest.fn() })
      .overrideProvider(getQueueToken(NIGHT_MODE_TRANSITION_QUEUE))
      .useValue({})
      .compile();

    try {
      const registry = moduleRef.get(MaxBotRegistryService);
      const scheduler = moduleRef.get(NightModeTransitionSchedulerService);

      expect(moduleRef.get(MaxBotLinkService)).toBeInstanceOf(MaxBotLinkService);
      expect(
        (scheduler as unknown as { maxBotRegistry?: MaxBotRegistryService }).maxBotRegistry,
      ).toBe(registry);
      expect((scheduler as unknown as { redisCounter?: RedisCounterService }).redisCounter).toBe(
        moduleRef.get(RedisCounterService),
      );
    } finally {
      await moduleRef.close();
    }
  });
});
