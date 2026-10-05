import {
  createDuplicateDeleteAuthorizationGuard,
  createDuplicateMemberMutationGuard,
} from './duplicate-execution-guards';

describe('duplicate delete authorization', () => {
  it('runs the final lease and route within member authority before its final permit', async () => {
    const order: string[] = [];
    const lease = {
      assertOwned: async () => {
        order.push('lease');
      },
    };
    const guard = createDuplicateMemberMutationGuard(lease, async (beforeFinalAuthority) => {
      order.push('external-author');
      await beforeFinalAuthority?.();
      order.push('final-permit');
    })!;
    await guard(async () => {
      order.push('route');
    });
    expect(order).toEqual(['lease', 'external-author', 'lease', 'route', 'final-permit']);
  });
  it('distinguishes a transient verification failure from a confirmed rejection', async () => {
    const failure = new Error('temporary MAX failure');
    const authorizeDelete = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(true);
    const guard = createDuplicateDeleteAuthorizationGuard({ authorizeDelete });
    await expect(guard.beforeImmediateDeleteMutation!()).rejects.toBe(failure);
    expect(guard.wasRejected()).toBe(false);
    expect(guard.verificationFailed()).toBe(true);
    await expect(guard.beforeImmediateDeleteMutation!()).resolves.toBeUndefined();
    expect(guard.wasRejected()).toBe(false);
    expect(guard.verificationFailed()).toBe(false);
  });

  it('marks only a verified refusal as rejected', async () => {
    const guard = createDuplicateDeleteAuthorizationGuard({
      authorizeDelete: jest.fn().mockResolvedValue(false),
    });
    await expect(guard.beforeImmediateDeleteMutation!()).rejects.toThrow(
      'authorization was revoked',
    );
    expect(guard.wasRejected()).toBe(true);
    expect(guard.verificationFailed()).toBe(false);
  });
});
