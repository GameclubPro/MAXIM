import { DelayedError, type Job } from 'bullmq';
import {
  MessageDuplicateEnqueueService,
  MessageDuplicateOrderingStore,
  type MessageDuplicateJob,
} from './message-duplicate.queue';
import { MessageDuplicateProcessor } from './message-duplicate.processor';
import { MessageDuplicateMediaDeferredError } from './message-duplicate-media.service';

function jobData(): MessageDuplicateJob {
  const now = new Date().toISOString();
  return {
    version: 1,
    webhookEventId: 'receipt',
    chatId: '-123',
    messageId: 'm',
    eventTimestampMs: Date.parse(now),
    sourceCreatedAt: now,
    createdAt: now,
    settingsDigest: 'a'.repeat(64),
    controlRevision: 1,
    actionEligible: true,
    idempotencyKey: `message-duplicate__${'b'.repeat(64)}`,
  };
}
describe('message duplicate queue', () => {
  it('uses one deterministic reference-only job and never upgrades a restrictive replay', async () => {
    const queue = { add: jest.fn() };
    const ordering = {
      announce: jest.fn().mockResolvedValue({ kind: 'registered', actionEligible: false }),
    };
    const service = new MessageDuplicateEnqueueService(queue as never, ordering as never);
    await service.enqueue(jobData());
    expect(queue.add).toHaveBeenCalledWith(
      'message-duplicate-analysis',
      expect.objectContaining({ actionEligible: false }),
      expect.objectContaining({ attempts: 5, delay: 5000 }),
    );
    const first = queue.add.mock.calls[0]![1].idempotencyKey;
    await service.enqueue({
      ...jobData(),
      sourceCreatedAt: queue.add.mock.calls[0]![1].sourceCreatedAt,
      eventTimestampMs: queue.add.mock.calls[0]![1].eventTimestampMs,
    });
    expect(queue.add.mock.calls[1]![1].idempotencyKey).toBe(first);
    queue.add.mockRejectedValueOnce(new Error('ambiguous enqueue'));
    await expect(service.enqueue(jobData())).rejects.toThrow('ambiguous enqueue');
    expect(ordering.announce).toHaveBeenLastCalledWith(expect.anything(), false);
  });
  it('isolates media ordering from the existing photo queue', async () => {
    const store = Object.create(
      MessageDuplicateOrderingStore.prototype,
    ) as MessageDuplicateOrderingStore;
    const redis = { eval: jest.fn().mockResolvedValue([1, 'member', '1']) };
    Object.defineProperties(store, {
      redis: { value: redis },
      namespace: { value: 'message-duplicate:ordering:v1' },
    });
    const data = jobData();
    await store.announce(
      { jobId: data.idempotencyKey, chatId: data.chatId, sourceCreatedAt: data.sourceCreatedAt },
      true,
    );
    expect(redis.eval.mock.calls[0]![2]).toMatch(/^message-duplicate:ordering:v1:/);
  });
  it('uses delayed retries without consuming attempts, bounded by an absolute lifetime', async () => {
    const execution = { processMessageDuplicateJob: jest.fn() };
    const ordering = {
      runInOrder: jest.fn().mockRejectedValue(new MessageDuplicateMediaDeferredError()),
      abandon: jest.fn(),
    };
    const processor = new MessageDuplicateProcessor(execution as never, ordering as never);
    const data = jobData();
    const moveToDelayed = jest.fn();
    const job = {
      id: data.idempotencyKey,
      data,
      attemptsMade: 0,
      opts: { attempts: 5 },
      moveToDelayed,
    } as unknown as Job<MessageDuplicateJob>;
    await expect(processor.process(job, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(ordering.abandon).not.toHaveBeenCalled();
    data.createdAt = new Date(Date.now() - 600001).toISOString();
    await processor.process(job, 'token');
    expect(ordering.abandon).toHaveBeenCalledTimes(1);
  });
  it('abandons a final processing failure and rejects malformed envelopes', async () => {
    const ordering = {
      runInOrder: jest.fn().mockRejectedValue(new Error('download')),
      abandon: jest.fn(),
    };
    const processor = new MessageDuplicateProcessor({} as never, ordering as never);
    const data = jobData();
    const job = {
      id: data.idempotencyKey,
      data,
      attemptsMade: 4,
      opts: { attempts: 5 },
    } as Job<MessageDuplicateJob>;
    await expect(processor.process(job, 'token')).rejects.toThrow('download');
    expect(ordering.abandon).toHaveBeenCalledTimes(1);
    await expect(
      processor.process({ ...job, data: { ...data, actionEligible: 'true' } } as never),
    ).rejects.toThrow('Invalid message duplicate job');
  });
});
