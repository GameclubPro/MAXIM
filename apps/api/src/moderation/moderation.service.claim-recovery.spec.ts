import { claimAndPersistModerationMessageViolation } from './moderation-violation-persistence';

type ClaimRow = {
  id: string;
  dedupeKey: string;
  messageActionKey: string | null;
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  updateType: string;
};

type ViolationRow = {
  chatId: string;
  userId: string;
  ruleCode: string;
  score: number;
};

function createClaimRecoveryHarness() {
  let committedClaim: ClaimRow | null = null;
  const committedViolations: ViolationRow[] = [];
  let nextViolationError: Error | null = null;
  let nextCommitError: Error | null = null;
  let nextForeignCommitError: Error | null = null;

  const claimCreateMany = jest.fn(
    async (args: { data: ClaimRow[] }): Promise<{ count: number }> => {
      if (committedClaim) {
        return { count: 0 };
      }
      return args.data[0] ? { count: 1 } : { count: 0 };
    },
  );
  const violationCreate = jest.fn(async (args: { data: ViolationRow }) => {
    if (nextViolationError) {
      const error = nextViolationError;
      nextViolationError = null;
      throw error;
    }
    return args.data;
  });
  const markRedis = jest.fn().mockResolvedValue(true);
  const claimFallback = jest.fn().mockResolvedValue(true);
  const onDuplicate = jest.fn();
  const claimFindUnique = jest.fn(
    async (args: {
      where: { dedupeKey: string };
      select: { id: true };
    }): Promise<{ id: string } | null> => {
      if (!committedClaim || committedClaim.dedupeKey !== args.where.dedupeKey) {
        return null;
      }
      return { id: committedClaim.id };
    },
  );
  const transaction = jest.fn(
    async (operation: (tx: unknown) => Promise<boolean>): Promise<boolean> => {
      let stagedClaim: ClaimRow | null = null;
      let stagedViolation: ViolationRow | null = null;
      const tx = {
        moderationViolationMessageClaim: {
          createMany: jest.fn(async (args: { data: ClaimRow[] }) => {
            const result = await claimCreateMany(args);
            if (result.count > 0) {
              stagedClaim = args.data[0] ?? null;
            }
            return result;
          }),
        },
        violation: {
          create: jest.fn(async (args: { data: ViolationRow }) => {
            const result = await violationCreate(args);
            stagedViolation = args.data;
            return result;
          }),
        },
      };

      const result = await operation(tx);
      if (nextForeignCommitError) {
        const error = nextForeignCommitError;
        nextForeignCommitError = null;
        if (stagedClaim) {
          const foreignClaim = stagedClaim as ClaimRow;
          committedClaim = {
            ...foreignClaim,
            id: `foreign-${foreignClaim.id}`,
          };
        }
        if (stagedViolation) {
          committedViolations.push(stagedViolation);
        }
        throw error;
      }
      if (stagedClaim) {
        committedClaim = stagedClaim;
      }
      if (stagedViolation) {
        committedViolations.push(stagedViolation);
      }
      if (nextCommitError) {
        const error = nextCommitError;
        nextCommitError = null;
        throw error;
      }
      return result;
    },
  );
  const prisma = {
    $transaction: transaction,
    moderationViolationMessageClaim: {
      createMany: jest.fn(),
      findUnique: claimFindUnique,
    },
    violation: {
      create: jest.fn(),
    },
  };
  const claimAndPersist = (overrides: { updateType?: string; ruleCode?: string } = {}) =>
    claimAndPersistModerationMessageViolation(
      prisma as never,
      {
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        ruleCode: overrides.ruleCode ?? 'LINK_BLOCKED',
        updateType: overrides.updateType ?? 'message_created',
        score: 0.9,
      },
      claimFallback,
      onDuplicate,
      markRedis,
    );

  return {
    claimAndPersist,
    claimCreateMany,
    claimFindUnique,
    violationCreate,
    markRedis,
    onDuplicate,
    transaction,
    getCommittedClaim: () => committedClaim,
    getCommittedViolations: () => [...committedViolations],
    failNextViolation: (error: Error) => {
      nextViolationError = error;
    },
    failNextCommitAfterCommit: (error: Error) => {
      nextCommitError = error;
    },
    failNextCommitAfterRollbackWithForeignClaim: (error: Error) => {
      nextForeignCommitError = error;
    },
  };
}

describe('ModerationService message violation claim recovery', () => {
  it('rolls back a claim when violation persistence fails and lets a retry claim it', async () => {
    const harness = createClaimRecoveryHarness();
    const failure = new Error('violation insert failed');
    harness.failNextViolation(failure);

    await expect(harness.claimAndPersist()).rejects.toBe(failure);
    expect(harness.getCommittedClaim()).toBeNull();
    expect(harness.getCommittedViolations()).toEqual([]);
    expect(harness.markRedis).not.toHaveBeenCalled();

    await expect(harness.claimAndPersist()).resolves.toBe(true);
    expect(harness.getCommittedClaim()).toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        ruleCode: 'LINK_BLOCKED',
        updateType: 'message_created',
      }),
    );
    expect(harness.getCommittedViolations()).toEqual([
      {
        chatId: 'chat-1',
        userId: 'user-1',
        ruleCode: 'LINK_BLOCKED',
        score: 0.9,
      },
    ]);
    expect(harness.markRedis).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed claim as the duplicate fence after downstream work may start', async () => {
    const harness = createClaimRecoveryHarness();
    let remoteMutationAttempts = 0;

    if (await harness.claimAndPersist()) {
      remoteMutationAttempts += 1;
    }
    if (await harness.claimAndPersist()) {
      remoteMutationAttempts += 1;
    }

    expect(remoteMutationAttempts).toBe(1);
    expect(harness.violationCreate).toHaveBeenCalledTimes(1);
    expect(harness.markRedis).toHaveBeenCalledTimes(1);
    expect(harness.onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('does not block downstream work on a never-resolving Redis warm after commit', async () => {
    const harness = createClaimRecoveryHarness();
    harness.markRedis.mockImplementationOnce(() => new Promise(() => undefined));

    await expect(harness.claimAndPersist()).resolves.toBe(true);
    expect(harness.getCommittedClaim()).not.toBeNull();
    expect(harness.getCommittedViolations()).toHaveLength(1);
    expect(harness.markRedis).toHaveBeenCalledTimes(1);
  });

  it('atomically persists message-action violations without a redundant Redis marker', async () => {
    const harness = createClaimRecoveryHarness();

    await expect(
      harness.claimAndPersist({
        updateType: 'message_action',
        ruleCode: 'REQUIRED_SUBSCRIPTION',
      }),
    ).resolves.toBe(true);
    expect(harness.getCommittedClaim()).toEqual(
      expect.objectContaining({
        messageActionKey: expect.any(String),
        updateType: 'message_action',
        ruleCode: 'REQUIRED_SUBSCRIPTION',
      }),
    );
    expect(harness.getCommittedViolations()).toEqual([
      expect.objectContaining({ ruleCode: 'REQUIRED_SUBSCRIPTION', score: 0.9 }),
    ]);
    expect(harness.markRedis).not.toHaveBeenCalled();
  });

  it('continues downstream work once after reconciling its own ambiguous commit', async () => {
    const harness = createClaimRecoveryHarness();
    const ambiguousCommit = new Error('connection reset after commit');
    harness.failNextCommitAfterCommit(ambiguousCommit);
    let downstreamAttempts = 0;

    if (await harness.claimAndPersist()) {
      downstreamAttempts += 1;
    }
    expect(harness.getCommittedClaim()).not.toBeNull();
    expect(harness.getCommittedViolations()).toHaveLength(1);
    expect(harness.claimFindUnique).toHaveBeenCalledWith({
      where: { dedupeKey: harness.getCommittedClaim()?.dedupeKey },
      select: { id: true },
    });
    expect(harness.markRedis).toHaveBeenCalledTimes(1);

    if (await harness.claimAndPersist()) {
      downstreamAttempts += 1;
    }
    expect(downstreamAttempts).toBe(1);
    expect(harness.violationCreate).toHaveBeenCalledTimes(1);
    expect(harness.getCommittedViolations()).toHaveLength(1);
    expect(harness.markRedis).toHaveBeenCalledTimes(1);
    expect(harness.onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('does not claim a foreign commit after its completed transaction callback rolls back', async () => {
    const harness = createClaimRecoveryHarness();
    const ambiguousCommit = new Error('transaction outcome unavailable');
    harness.failNextCommitAfterRollbackWithForeignClaim(ambiguousCommit);

    await expect(harness.claimAndPersist()).rejects.toBe(ambiguousCommit);
    const attemptedClaim = harness.claimCreateMany.mock.calls[0]?.[0].data[0];
    expect(harness.getCommittedClaim()?.id).not.toBe(attemptedClaim?.id);
    expect(harness.getCommittedViolations()).toHaveLength(1);
    expect(harness.claimFindUnique).toHaveBeenCalledTimes(1);
    expect(harness.markRedis).not.toHaveBeenCalled();

    await expect(harness.claimAndPersist()).resolves.toBe(false);
    expect(harness.violationCreate).toHaveBeenCalledTimes(1);
    expect(harness.getCommittedViolations()).toHaveLength(1);
    expect(harness.markRedis).not.toHaveBeenCalled();
  });
});
