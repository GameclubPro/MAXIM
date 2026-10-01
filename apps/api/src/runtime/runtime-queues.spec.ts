import { BullModule, getQueueToken, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { registerRuntimeQueues } from './runtime-queues';

const SHARED_QUEUE = 'runtime-registry-shared-spec';
const SECOND_QUEUE = 'runtime-registry-second-spec';

@Injectable()
class FirstConsumer {
  constructor(@InjectQueue(SHARED_QUEUE) readonly queue: unknown) {}
}

@Injectable()
class SecondConsumer {
  constructor(@InjectQueue(SHARED_QUEUE) readonly queue: unknown) {}
}

@Module({
  imports: [...registerRuntimeQueues(SHARED_QUEUE, SECOND_QUEUE)],
  providers: [FirstConsumer],
  exports: [FirstConsumer],
})
class FirstModule {}

@Module({
  imports: [...registerRuntimeQueues(SHARED_QUEUE)],
  providers: [SecondConsumer],
  exports: [SecondConsumer],
})
class SecondModule {}

async function compileContext() {
  const close = jest.fn();
  const createQueue = jest.fn(() => ({ onApplicationShutdown: close }));
  const context = await Test.createTestingModule({
    imports: [
      BullModule.forRoot({ connection: { host: '127.0.0.1', port: 6379 } }),
      FirstModule,
      SecondModule,
    ],
  })
    .overrideProvider(getQueueToken(SHARED_QUEUE))
    .useFactory({ factory: createQueue })
    .overrideProvider(getQueueToken(SECOND_QUEUE))
    .useValue({})
    .compile();
  return { context, close, createQueue };
}

describe('runtime Queue registry', () => {
  it('shares one Queue owner across separately grouped imports and closes it once', async () => {
    const { context, close, createQueue } = await compileContext();
    try {
      expect(context.get(FirstConsumer).queue).toBe(context.get(SecondConsumer).queue);
      expect(createQueue).toHaveBeenCalledTimes(1);
    } finally {
      await context.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not reuse live clients across independently owned Nest contexts', async () => {
    const first = await compileContext();
    const second = await compileContext();
    try {
      expect(first.context.get(FirstConsumer).queue).not.toBe(
        second.context.get(FirstConsumer).queue,
      );
      expect(first.createQueue).toHaveBeenCalledTimes(1);
      expect(second.createQueue).toHaveBeenCalledTimes(1);
    } finally {
      await first.context.close();
      await second.context.close();
    }
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});
