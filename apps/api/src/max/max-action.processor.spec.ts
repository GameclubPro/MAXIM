import type { Job } from 'bullmq';
import {
  MaxActionBackgroundProcessor,
  MaxActionCriticalProcessor,
  MaxActionInteractiveProcessor,
  MaxActionProcessor,
} from './max-action.processor';
import type { MaxActionJob } from './max-client.service';

function createJob(overrides: Partial<Job<MaxActionJob>> = {}): Job<MaxActionJob> {
  return {
    data: {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-1',
      createdAt: '2026-07-08T20:00:00.000Z',
    },
    attemptsMade: 0,
    opts: {
      attempts: 5,
    },
    ...overrides,
  } as Job<MaxActionJob>;
}

describe('MaxActionProcessor', () => {
  const originalAppRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'action';
  });

  afterAll(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
  });

  it('passes non-final BullMQ attempts to the action dispatch service', async () => {
    const dispatch = {
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new MaxActionProcessor(dispatch as never);

    await processor.process(createJob({ attemptsMade: 1 }));

    expect(dispatch.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 2,
        idempotencyKey: 'job-1',
      }),
      {
        finalAttempt: false,
      },
    );
  });

  it('marks exhausted BullMQ attempts as final for ledger recording', async () => {
    const dispatch = {
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new MaxActionProcessor(dispatch as never);

    await processor.process(createJob({ attemptsMade: 4 }));

    expect(dispatch.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 5,
        idempotencyKey: 'job-1',
      }),
      {
        finalAttempt: true,
      },
    );
  });

  it.each([
    MaxActionProcessor,
    MaxActionCriticalProcessor,
    MaxActionInteractiveProcessor,
    MaxActionBackgroundProcessor,
  ])('%p executes jobs through the shared dispatch boundary', async (ProcessorClass) => {
    const dispatch = {
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new ProcessorClass(dispatch as never);

    await processor.process(createJob());

    expect(dispatch.execute).toHaveBeenCalledTimes(1);
  });
});
