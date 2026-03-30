import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  getDefaultWebhookWorkerGroupQueues,
  getEnabledModerationProcessorQueues,
  moderationBackgroundTasksEnabled,
  moderationProcessorQueueEnabled,
} from './moderation-runtime';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';

describe('moderation-runtime', () => {
  it('enables every moderation queue when env is unset', () => {
    expect(getEnabledModerationProcessorQueues(undefined)).toEqual(
      new Set([
        LEGACY_WEBHOOK_QUEUE,
        WEBHOOK_QUEUE_CRITICAL,
        ...DEFAULT_WEBHOOK_QUEUE_NAMES,
        WEBHOOK_QUEUE_BACKGROUND,
      ]),
    );
  });

  it('accepts short queue aliases in MODERATION_ENABLED_QUEUES', () => {
    expect(getEnabledModerationProcessorQueues('critical,background')).toEqual(
      new Set([WEBHOOK_QUEUE_CRITICAL, WEBHOOK_QUEUE_BACKGROUND]),
    );
    expect(moderationProcessorQueueEnabled(WEBHOOK_QUEUE_CRITICAL, 'critical,background')).toBe(
      true,
    );
    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      expect(moderationProcessorQueueEnabled(queueName, 'critical,background')).toBe(false);
    }
  });

  it('expands default alias into every message shard queue', () => {
    expect(getEnabledModerationProcessorQueues('default')).toEqual(
      new Set(DEFAULT_WEBHOOK_QUEUE_NAMES),
    );
  });

  it('falls back to all queues when MODERATION_ENABLED_QUEUES is invalid', () => {
    expect(getEnabledModerationProcessorQueues('unknown')).toEqual(
      new Set([
        LEGACY_WEBHOOK_QUEUE,
        WEBHOOK_QUEUE_CRITICAL,
        ...DEFAULT_WEBHOOK_QUEUE_NAMES,
        WEBHOOK_QUEUE_BACKGROUND,
      ]),
    );
  });

  it('parses MODERATION_BACKGROUND_TASKS_ENABLED from booleans and strings', () => {
    expect(moderationBackgroundTasksEnabled(false)).toBe(false);
    expect(moderationBackgroundTasksEnabled('false')).toBe(false);
    expect(moderationBackgroundTasksEnabled('0')).toBe(false);
    expect(moderationBackgroundTasksEnabled('true')).toBe(true);
    expect(moderationBackgroundTasksEnabled(undefined)).toBe(true);
  });

  it('exposes the default shard ownership map used by realtime workers', () => {
    expect(DEFAULT_WEBHOOK_WORKER_GROUP_NAMES).toEqual([
      'api-moderation',
      'api-moderation-realtime-b',
      'api-moderation-realtime-c',
      'api-moderation-realtime-d',
    ]);
    const queues = getDefaultWebhookWorkerGroupQueues();
    expect(queues['api-moderation']).toEqual([
      'moderation-default-0',
      'moderation-default-4',
      'moderation-default-8',
      'moderation-default-12',
    ]);
    expect(queues['api-moderation-realtime-b']).toEqual([
      'moderation-default-1',
      'moderation-default-5',
      'moderation-default-9',
      'moderation-default-13',
    ]);
    expect(queues['api-moderation-realtime-c']).toEqual([
      'moderation-default-2',
      'moderation-default-6',
      'moderation-default-10',
      'moderation-default-14',
    ]);
    expect(queues['api-moderation-realtime-d']).toEqual([
      'moderation-default-3',
      'moderation-default-7',
      'moderation-default-11',
      'moderation-default-15',
    ]);
  });
});
