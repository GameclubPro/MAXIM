import { createAdminManualModerationRuntimeContext } from './admin-manual-moderation-runtime-context';

describe('AdminManualModerationRuntimeContext', () => {
  it('exposes queue and logger through typed accessors', () => {
    const target = {
      logger: { warn: jest.fn() },
      adminSuperBanQueue: { add: jest.fn() },
      enqueueManualModerationFanout: jest.fn(),
      isKnownRuntimeBotUserId: jest.fn(),
      isSuperBanDeveloperUserId: jest.fn(),
      processDeveloperSuperBanJob: jest.fn(),
      readTrimmedString: jest.fn(),
    };
    const context = createAdminManualModerationRuntimeContext(target);

    expect(context.logger).toBe(target.logger);
    expect(context.adminSuperBanQueue).toBe(target.adminSuperBanQueue);
  });

  it('delegates manual moderation helpers without losing the legacy target context', async () => {
    const target = {
      prefix: 'legacy',
      logger: { warn: jest.fn() },
      async enqueueManualModerationFanout(job: { kind: string }): Promise<boolean> {
        this.logger.warn(`${this.prefix}:fanout:${job.kind}`);
        return true;
      },
      isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
        return userId === `${this.prefix}-bot`;
      },
      isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
        return userId === `${this.prefix}-dev`;
      },
      async processDeveloperSuperBanJob(job: { jobId: string }): Promise<void> {
        this.logger.warn(`${this.prefix}:super-ban:${job.jobId}`);
      },
      readTrimmedString(value: unknown): string | null {
        return typeof value === 'string' ? `${this.prefix}:${value.trim()}` : null;
      },
    };
    const context = createAdminManualModerationRuntimeContext(target);

    await expect(
      context.enqueueManualModerationFanout({ kind: 'manual_group_moderation_command' } as never),
    ).resolves.toBe(true);
    expect(context.isKnownRuntimeBotUserId('legacy-bot')).toBe(true);
    expect(context.isSuperBanDeveloperUserId('legacy-dev')).toBe(true);
    await context.processDeveloperSuperBanJob({ jobId: 'job-1' } as never);
    expect(context.readTrimmedString(' value ')).toBe('legacy:value');
    expect(target.logger.warn).toHaveBeenCalledWith(
      'legacy:fanout:manual_group_moderation_command',
    );
    expect(target.logger.warn).toHaveBeenCalledWith('legacy:super-ban:job-1');
  });
});
