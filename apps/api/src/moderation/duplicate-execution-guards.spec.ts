import {
  createDuplicateDeleteAuthorizationGuard,
  createDuplicateMemberMutationGuard,
} from './duplicate-execution-guards';
import {
  usesMaxFinalAuthorityCheckpoint,
  withMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';

describe('duplicate delete authorization', () => {
  it('runs the final lease and route within member authority before its final permit', async () => {
    const order: string[] = [];
    const lease = {
      assertOwned: async () => {
        order.push('lease');
      },
    };
    const guard = createDuplicateMemberMutationGuard(
      lease,
      withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
        order.push('external-author');
        await beforeFinalAuthority?.();
        order.push('final-permit');
      }),
    )!;
    await guard(async () => {
      order.push('route');
    });
    expect(usesMaxFinalAuthorityCheckpoint(guard)).toBe(true);
    expect(order).toEqual(['lease', 'external-author', 'route', 'lease', 'final-permit']);
  });

  it.each(['lease-only', 'marked-authority'] as const)(
    'refuses mutation when %s loses its lease during quota admission',
    async (branch) => {
      let leaseOwned = true;
      const lostLease = new Error('Lease expired during quota admission');
      const lease = {
        assertOwned: jest.fn(async () => {
          if (!leaseOwned) throw lostLease;
        }),
      };
      const finalPermit = jest.fn();
      const mutation = jest.fn();
      const authority = withMaxFinalAuthorityCheckpoint(
        async (checkpoint?: () => Promise<void>) => {
          await checkpoint?.();
          finalPermit();
        },
      );
      const guard = createDuplicateMemberMutationGuard(
        lease,
        branch === 'marked-authority' ? authority : undefined,
      )!;
      const checkpoint = jest.fn(async () => {
        leaseOwned = false;
      });
      expect(usesMaxFinalAuthorityCheckpoint(guard)).toBe(true);
      await expect(
        (async () => {
          await guard(checkpoint);
          mutation();
        })(),
      ).rejects.toBe(lostLease);
      expect(checkpoint).toHaveBeenCalledTimes(1);
      expect(lease.assertOwned).toHaveBeenCalledTimes(2);
      expect(finalPermit).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    },
  );
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
