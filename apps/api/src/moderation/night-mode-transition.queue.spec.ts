import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionJobIdPrefix,
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
});
