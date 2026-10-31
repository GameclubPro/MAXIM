import type { ModuleRef } from '@nestjs/core';
import { RequiredSubscriptionCandidateService } from './required-subscription-candidate.service';
import type {
  RequiredSubscriptionCandidateRow,
  RequiredSubscriptionCandidateStore,
} from './required-subscription-candidate.store';
import type { ModerationExecutionService } from './moderation-execution.service';
import type {
  RuleFollowupSanctionJournal,
  RuleFollowupSanctionState,
} from './moderation-rule-followup-sanction';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const now = Date.now();
  const row: RequiredSubscriptionCandidateRow = {
    id: 'candidate',
    chatId: 'chat',
    userId: 'user',
    messageId: 'message',
    sourceAt: new Date(now - 1000),
    deadlineAt: new Date(now + 299000),
    policySha256: 'a'.repeat(64),
    source: {
      version: 1,
      chatId: 'chat',
      userId: 'user',
      messageId: 'message',
      sourceAtMs: now - 1000,
      deadlineAtMs: now + 299000,
      policySha256: 'a'.repeat(64),
      originBotId: 'bot',
      updateType: 'message_created',
      mediaScope: null,
      userLabel: 'User',
      maskedExcerpt: null,
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    },
    status: 'RUNNING',
    frozenPlan: null,
    claimId: null,
    effects: {},
    nextAttemptAt: new Date(now),
    leaseToken: 'lease',
    leaseExpiresAt: new Date(now + 30000),
    attemptCount: 1,
    lastError: null,
    completedAt: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  let state: RuleFollowupSanctionState = { phase: 'UNSTARTED' };
  const journal = {
    id: row.id,
    assertLease: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    readState: jest.fn(async () => state),
    beginBan: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true),
    confirmBan: jest.fn<Promise<void>, [string | null]>().mockResolvedValue(undefined),
    resetAfterProvenNoEffect: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    markUnknown: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    commitSqlEvent: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    claimReputation: jest.fn<Promise<'run' | 'done' | 'unknown'>, []>().mockResolvedValue('done'),
    completeReputation: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    settle: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  } satisfies RuleFollowupSanctionJournal;
  const store = {
    listDueIds: jest
      .fn<ReturnType<RequiredSubscriptionCandidateStore['listDueIds']>, []>()
      .mockResolvedValue([row.id]),
    claim: jest
      .fn<ReturnType<RequiredSubscriptionCandidateStore['claim']>, [string]>()
      .mockResolvedValue(row),
    renewLease: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
    assertLease: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
    journal: jest
      .fn<RuleFollowupSanctionJournal, [string, string, boolean?]>()
      .mockReturnValue(journal),
    finish: jest
      .fn<
        ReturnType<RequiredSubscriptionCandidateStore['finish']>,
        Parameters<RequiredSubscriptionCandidateStore['finish']>
      >()
      .mockResolvedValue(undefined),
  } satisfies Pick<
    RequiredSubscriptionCandidateStore,
    'listDueIds' | 'claim' | 'renewLease' | 'assertLease' | 'journal' | 'finish'
  >;
  const executor = {
    executeRequiredSubscriptionCandidate: jest
      .fn<
        ReturnType<ModerationExecutionService['executeRequiredSubscriptionCandidate']>,
        Parameters<ModerationExecutionService['executeRequiredSubscriptionCandidate']>
      >()
      .mockResolvedValue(undefined),
  };
  const moduleRef = { get: jest.fn().mockReturnValue(executor) };
  const service = new RequiredSubscriptionCandidateService(
    store as unknown as RequiredSubscriptionCandidateStore,
    moduleRef as unknown as ModuleRef,
  );
  return {
    service,
    store,
    row,
    executor,
    journal,
    setState(value: RuleFollowupSanctionState) {
      state = value;
    },
  };
}

describe('required subscription candidate worker admission and recovery', () => {
  const originalRole = process.env.APP_ROLE;
  afterEach(() => {
    jest.useRealTimers();
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
  });

  it.each(['ingress', 'admin', 'enqueue', 'moderation', 'message-retention', 'publisher'])(
    'does not poll from the %s role',
    async (role) => {
      jest.useFakeTimers();
      process.env.APP_ROLE = role;
      const f = fixture();
      f.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(5000);
      expect(f.store.listDueIds).not.toHaveBeenCalled();
      await f.service.onModuleDestroy();
    },
  );

  it('polls from the action role and stops its timer before shutdown', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'action';
    const f = fixture();
    f.service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.store.listDueIds).toHaveBeenCalledTimes(1);
    await f.service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(f.store.listDueIds).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping discovery without executing a candidate twice', async () => {
    const f = fixture();
    const execution = deferred<void>();
    f.executor.executeRequiredSubscriptionCandidate.mockReturnValue(execution.promise);
    const first = f.service.sweep();
    const second = f.service.sweep();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.store.listDueIds).toHaveBeenCalledTimes(1);
    execution.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(f.executor.executeRequiredSubscriptionCandidate).toHaveBeenCalledTimes(1);
    expect(f.store.finish).not.toHaveBeenCalled();
    await f.service.onModuleDestroy();
  });

  it('does not start a discovered candidate after shutdown froze admission', async () => {
    const f = fixture();
    const selection = deferred<string[]>();
    f.store.listDueIds.mockReturnValue(selection.promise);
    const sweep = f.service.sweep();
    const [worker] = f.service.stopWorkerAdmission();
    const paused = worker!.pause(false);
    selection.resolve(['candidate']);
    expect(await sweep).toBe(0);
    await paused;
    expect(f.store.claim).not.toHaveBeenCalled();
    expect(await f.service.sweep()).toBe(0);
    expect(await f.service.attempt('candidate')).toBe(false);
  });

  it('drains an admitted candidate before store teardown', async () => {
    const f = fixture();
    const execution = deferred<void>();
    f.executor.executeRequiredSubscriptionCandidate.mockReturnValue(execution.promise);
    const attempt = f.service.attempt('candidate');
    await Promise.resolve();
    await Promise.resolve();
    const [worker] = f.service.stopWorkerAdmission();
    let drained = false;
    const pause = Promise.resolve(worker!.pause(false)).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    execution.resolve();
    await attempt;
    await pause;
    expect(drained).toBe(true);
    expect(await f.service.attempt('next')).toBe(false);
  });

  it('does not execute a candidate claimed by a competing process', async () => {
    const f = fixture();
    f.store.claim.mockResolvedValue(null);
    expect(await f.service.attempt('candidate')).toBe(false);
    expect(f.executor.executeRequiredSubscriptionCandidate).not.toHaveBeenCalled();
  });

  it('retains a read failure for durable retry without claiming an unknown effect', async () => {
    const f = fixture();
    f.executor.executeRequiredSubscriptionCandidate.mockRejectedValue(
      new Error('Read unavailable'),
    );
    await f.service.attempt('candidate');
    expect(f.store.finish).toHaveBeenCalledWith(
      'candidate',
      'lease',
      'WAITING_CHECK',
      'REQUIRED_SUBSCRIPTION_READ_RETRY',
      1000,
    );
  });

  it.each(['BAN_STARTED', 'UNKNOWN'] as const)(
    'retains %s for receipt recovery without a retryable sanction',
    async (phase) => {
      const f = fixture();
      f.setState({ phase });
      f.executor.executeRequiredSubscriptionCandidate.mockRejectedValue(
        new Error('Process interrupted'),
      );
      await f.service.attempt('candidate');
      expect(f.store.finish).toHaveBeenCalledWith(
        'candidate',
        'lease',
        'UNKNOWN',
        'REQUIRED_SUBSCRIPTION_EFFECT_UNKNOWN',
        60000,
      );
    },
  );

  it('does not finish an attempt after another process owns its lease', async () => {
    const f = fixture();
    f.store.assertLease.mockRejectedValue(new Error('Lease lost'));
    f.executor.executeRequiredSubscriptionCandidate.mockRejectedValue(
      new Error('Store unavailable'),
    );
    await f.service.attempt('candidate');
    expect(f.store.finish).not.toHaveBeenCalled();
  });

  it('passes expired candidates through receipt-only settlement with their original deadline', async () => {
    const f = fixture();
    f.row.deadlineAt = new Date(Date.now() - 1);
    await f.service.attempt('candidate');
    expect(f.store.journal).toHaveBeenCalledWith('candidate', 'lease', true);
    expect(f.executor.executeRequiredSubscriptionCandidate).toHaveBeenCalledWith({
      row: f.row,
      store: f.store,
      journal: f.journal,
    });
  });

  it('renews an active lease but stops heartbeat after completion', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const execution = deferred<void>();
    f.executor.executeRequiredSubscriptionCandidate.mockReturnValue(execution.promise);
    const attempt = f.service.attempt('candidate');
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5000);
    expect(f.store.renewLease).toHaveBeenCalledWith('candidate', 'lease');
    execution.resolve();
    await attempt;
    await jest.advanceTimersByTimeAsync(15000);
    expect(f.store.renewLease).toHaveBeenCalledTimes(1);
  });
});
