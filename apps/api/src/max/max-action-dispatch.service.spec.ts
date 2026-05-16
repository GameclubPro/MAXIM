import { MaxActionDispatchService } from './max-action-dispatch.service';
import type { MaxActionJob } from './max-client.service';

describe('MaxActionDispatchService', () => {
  it('executes queued MAX action jobs through the client boundary', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(maxClient as never);
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'message-1',
      attempt: 2,
      idempotencyKey: 'job-1',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await service.execute(job);

    expect(maxClient.executeActionJob).toHaveBeenCalledWith(job);
  });
});
