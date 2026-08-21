import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionJobIdPrefix,
  buildNightModeTransitionRecoveryJobId,
  NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  parseNightModeTransitionRecoveryOnly,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';

describe('night mode transition queue', () => {
  it('builds BullMQ-safe custom job ids', () => {
    const jobId = buildNightModeTransitionJobId(
      'chat-1',
      'open',
      '2026-05-31T05:00:00.000Z',
      'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    );
    const prefix = buildNightModeTransitionJobIdPrefix('chat-1');

    expect(jobId.startsWith(prefix)).toBe(true);
    expect(jobId).not.toContain(':');
    expect(prefix).not.toContain(':');
  });

  it('marks SQL/event-only close recovery explicitly on either boundary job', () => {
    const recoveryOnly = {
      kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
      version: 1 as const,
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      messageId: 'close-message-1',
      botId: 'bot-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    };
    const job: NightModeTransitionJob = {
      chatId: 'chat-1',
      transition: 'open',
      scheduledFor: '2026-05-31T05:00:00.000Z',
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      recoveryOnly,
    };

    expect(parseNightModeTransitionRecoveryOnly(job.recoveryOnly)).toEqual(recoveryOnly);
    expect(buildNightModeTransitionRecoveryJobId(job.chatId, recoveryOnly)).not.toBe(
      buildNightModeTransitionJobId(job.chatId, job.transition, job.scheduledFor, job.sessionKey),
    );
  });

  it('rejects a recovery envelope whose immutable schedule does not match its session', () => {
    expect(
      parseNightModeTransitionRecoveryOnly({
        kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
        version: 1,
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        messageId: 'close-message-1',
        botId: 'bot-1',
        timezone: 'UTC',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).toBeNull();
  });
});
