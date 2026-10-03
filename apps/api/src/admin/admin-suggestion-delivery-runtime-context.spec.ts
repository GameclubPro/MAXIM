import { AdminSuggestionDeliveryRuntime } from './admin-suggestion-delivery-runtime';
import { createAdminSuggestionDeliveryRuntimeContext } from './admin-suggestion-delivery-runtime-context';

function fixture() {
  const add = jest.fn().mockResolvedValue({});
  const getJob = jest.fn().mockResolvedValue(null);
  const process = jest.fn().mockResolvedValue(undefined);
  const context = createAdminSuggestionDeliveryRuntimeContext({
    logger: { warn: jest.fn() } as never,
    adminSuggestionDeliveryQueue: { add, getJob } as never,
    processChannelSuggestionDeliveryJobWithinTimeout: process,
  });
  return { context, add, getJob, process, runtime: new AdminSuggestionDeliveryRuntime(context) };
}

describe('suggestion delivery capability boundary', () => {
  it('preserves job identity, payload and retry policy', async () => {
    const f = fixture();
    await expect(f.runtime.enqueueChannelSuggestionDelivery('audit-1')).resolves.toBe(true);
    expect(f.add).toHaveBeenCalledWith(
      'deliver-channel-suggestion',
      { auditLogId: 'audit-1' },
      {
        jobId: 'channel-suggestion-delivery__audit-1',
        attempts: 8,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
    await f.runtime.processChannelSuggestionDeliveryJob('audit-1');
    expect(f.process).toHaveBeenCalledWith('audit-1');
  });

  it.each(['failed', 'completed'])(
    'recovers the same %s job without enqueueing a duplicate',
    async (state) => {
      const f = fixture();
      const retry = jest.fn();
      f.getJob.mockResolvedValue({ getState: async () => state, retry });
      await expect(
        f.runtime.enqueueChannelSuggestionDelivery('audit-1', { recoverFailed: true }),
      ).resolves.toBe(true);
      expect(f.getJob).toHaveBeenCalledWith('channel-suggestion-delivery__audit-1');
      expect(retry).toHaveBeenCalledWith(state, {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      expect(f.add).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'waiting', 'delayed'])(
    'leaves an existing %s job with its current owner',
    async (state) => {
      const f = fixture();
      const retry = jest.fn();
      f.getJob.mockResolvedValue({ getState: async () => state, retry });
      await expect(
        f.runtime.enqueueChannelSuggestionDelivery('audit-1', { recoverFailed: true }),
      ).resolves.toBe(false);
      expect(retry).not.toHaveBeenCalled();
      expect(f.add).not.toHaveBeenCalled();
    },
  );

  it('preserves late queue initialization and worker receiver binding', async () => {
    const owner = {
      queue: undefined as typeof context.adminSuggestionDeliveryQueue,
      prefix: 'current',
      process: jest.fn().mockResolvedValue(undefined),
    };
    const context = createAdminSuggestionDeliveryRuntimeContext({
      logger: { warn: jest.fn() } as never,
      get adminSuggestionDeliveryQueue() {
        return owner.queue;
      },
      processChannelSuggestionDeliveryJobWithinTimeout: (id) =>
        owner.process(`${owner.prefix}:${id}`),
    });
    const runtime = new AdminSuggestionDeliveryRuntime(context);
    await expect(runtime.enqueueChannelSuggestionDelivery('audit-1')).resolves.toBe(false);
    const add = jest.fn();
    owner.queue = { add } as never;
    await expect(runtime.enqueueChannelSuggestionDelivery('audit-1')).resolves.toBe(true);
    owner.prefix = 'replaced';
    await runtime.processChannelSuggestionDeliveryJob('audit-1');
    expect(owner.process).toHaveBeenCalledWith('replaced:audit-1');
  });
});
