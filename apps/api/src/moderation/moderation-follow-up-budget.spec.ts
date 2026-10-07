import { ModerationService } from './moderation.service';
import type { WebhookHotPathProfile } from './moderation.service.support';

type FollowUpParams = {
  stage: string;
  hotPathProfile?: WebhookHotPathProfile | null;
  chatId: string;
  userId?: string;
  messageId?: string;
  maxWaitMs: number;
  task: () => Promise<void>;
};

type FollowUpService = {
  runWebhookFollowUpWithBudget(params: FollowUpParams): Promise<void>;
  createWebhookHotPathProfile(): WebhookHotPathProfile;
  scheduleDetachedWebhookFollowUp(params: unknown): void;
};

function fixture() {
  const service = Object.create(ModerationService.prototype) as FollowUpService;
  const logger = { warn: jest.fn(), debug: jest.fn() };
  const recordHotPathStageOutcome = jest.fn();
  Object.assign(service, {
    logger,
    runtimeDiagnosticsService: { recordHotPathStageOutcome },
    webhookUserFacingTimeoutMs: 10_000,
  });
  const profile = service.createWebhookHotPathProfile();
  profile.successBoundaryReached = true;
  profile.successBoundaryStage = 'duplicate-delete';
  const schedule = jest.spyOn(service, 'scheduleDetachedWebhookFollowUp');
  const run = (task: FollowUpParams['task'], overrides: Partial<FollowUpParams> = {}) =>
    service.runWebhookFollowUpWithBudget({
      stage: 'duplicate-follow-up',
      hotPathProfile: profile,
      chatId: 'private-chat-id',
      userId: 'private-user-id',
      messageId: 'private-message-id',
      maxWaitMs: 2_000,
      task,
      ...overrides,
    });
  return { run, profile, logger, recordHotPathStageOutcome, schedule };
}

describe('webhook optional duplicate explanation budget', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T00:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['rejected promise', 'synchronous throw'])(
    'settles a fast %s after the duplicate deletion without retrying the explanation',
    async (failure) => {
      const f = fixture();
      const error = new Error('private-token private-payload');
      const task = jest.fn(() => {
        if (failure === 'synchronous throw') throw error;
        return Promise.reject(error);
      });

      await expect(f.run(task)).resolves.toBeUndefined();
      await jest.runAllTimersAsync();

      expect(task).toHaveBeenCalledTimes(1);
      expect(f.schedule).not.toHaveBeenCalled();
      expect(f.logger.debug).not.toHaveBeenCalled();
      expect(f.logger.warn).toHaveBeenCalledTimes(1);
      expect(f.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'duplicate-follow-up' }),
        'Webhook follow-up failed after the user-facing success boundary',
      );
      const logged = JSON.stringify(f.logger.warn.mock.calls);
      for (const secret of [
        'private-token',
        'private-payload',
        'private-chat-id',
        'private-user-id',
        'private-message-id',
      ])
        expect(logged).not.toContain(secret);
      expect(f.recordHotPathStageOutcome.mock.calls).toEqual([
        [{ stage: 'follow_up_failed', outcome: 'skip', failOpen: true }],
        [{ stage: 'duplicate-follow-up.failed', outcome: 'skip', failOpen: true }],
      ]);
    },
  );

  it.each([
    'boundary not reached',
    'missing profile',
    'null profile',
    'violation with completed deletion',
    'unknown stage with completed deletion',
  ])('preserves the original fast failure for %s', async (scenario) => {
    const f = fixture();
    const error = new Error('Required work failed');
    const task = jest.fn().mockRejectedValue(error);
    const overrides: Partial<FollowUpParams> = {};
    if (scenario === 'boundary not reached') f.profile.successBoundaryReached = false;
    if (scenario === 'missing profile') overrides.hotPathProfile = undefined;
    if (scenario === 'null profile') overrides.hotPathProfile = null;
    if (scenario === 'violation with completed deletion') overrides.stage = 'violation-follow-up';
    if (scenario === 'unknown stage with completed deletion') overrides.stage = 'unknown-follow-up';

    await expect(f.run(task, overrides)).rejects.toBe(error);
    await jest.runAllTimersAsync();

    expect(task).toHaveBeenCalledTimes(1);
    expect(f.schedule).not.toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.recordHotPathStageOutcome).not.toHaveBeenCalled();
  });

  it('keeps one detached attempt when the same explanation fails after the budget', async () => {
    const f = fixture();
    let rejectTask!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    });
    const task = jest.fn(() => pending);
    const result = f.run(task);
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBeUndefined();
    expect(f.logger.warn).not.toHaveBeenCalled();

    rejectTask(new Error('Late optional explanation failure'));
    await jest.runAllTimersAsync();

    expect(task).toHaveBeenCalledTimes(1);
    expect(f.schedule).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'duplicate-follow-up' }),
      'Deferred webhook follow-up failed after the user-facing budget window',
    );
    expect(f.recordHotPathStageOutcome.mock.calls).toEqual([
      [{ stage: 'duplicate-follow-up.deferred', outcome: 'skip', failOpen: true }],
      [{ stage: 'follow_up_deferred', outcome: 'skip', failOpen: true }],
      [{ stage: 'follow_up_failed', outcome: 'timeout', failOpen: true }],
      [{ stage: 'duplicate-follow-up.failed', outcome: 'timeout', failOpen: true }],
    ]);
  });

  it('settles a successful explanation once without recording a failure or deferral', async () => {
    const f = fixture();
    const task = jest.fn().mockResolvedValue(undefined);

    await expect(f.run(task)).resolves.toBeUndefined();
    await jest.runAllTimersAsync();

    expect(task).toHaveBeenCalledTimes(1);
    expect(f.schedule).not.toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.logger.debug).not.toHaveBeenCalled();
    expect(f.recordHotPathStageOutcome).not.toHaveBeenCalled();
  });
});
