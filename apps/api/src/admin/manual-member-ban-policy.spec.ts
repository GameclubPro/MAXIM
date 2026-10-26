import { prepareManualBanFanoutTarget } from './manual-member-ban-policy';
import { ModerationSanctionStateLockLeaseLostError } from '../moderation/moderation-sanction-state-lock.service';

describe('manual BAN fanout reconciliation', () => {
  it('retains old BAN evidence when the lease is lost during fresh membership lookup', async () => {
    const subject = { chatId: 'chat-1', userId: 'user-1' };
    const leaseLost = new ModerationSanctionStateLockLeaseLostError(subject);
    const clearTerminalBanState = jest.fn<Promise<void>, [Date]>();
    const assertOwned = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(leaseLost);

    await expect(
      prepareManualBanFanoutTarget({
        chatId: subject.chatId,
        targetUserId: subject.userId,
        executionMode: 'MAX_BLOCK',
        leaseGuard: { assertOwned },
        resolveTargetState: async () => 'present',
        clearTerminalBanState,
      }),
    ).rejects.toBe(leaseLost);
    expect(clearTerminalBanState).not.toHaveBeenCalled();
  });
});
