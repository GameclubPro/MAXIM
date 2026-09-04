import { createHash } from 'node:crypto';

export const VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT = 'pending:v1';
export const VK_AUTOPUBLISH_SCHEDULE_FINGERPRINT_VERSION = 2;

export type VkAutoPublishTimingSettings = {
  schedulerTimezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  workHoursStart: string;
  workHoursEnd: string;
  distributeEvenlyEnabled: boolean;
  roundRobinEnabled: boolean;
};

export type VkAutoPublishTimingSource = {
  publishIntervalMinutes: number;
  dailyLimit: number;
  minPublishIntervalMinutes: number;
  publishMode: string;
  priority: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

export function buildVkAutoPublishScheduleFingerprint(
  settings: VkAutoPublishTimingSettings,
  source: VkAutoPublishTimingSource,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: VK_AUTOPUBLISH_SCHEDULE_FINGERPRINT_VERSION,
        settings: {
          schedulerTimezone: settings.schedulerTimezone,
          quietHoursStart: settings.quietHoursStart,
          quietHoursEnd: settings.quietHoursEnd,
          workHoursStart: settings.workHoursStart,
          workHoursEnd: settings.workHoursEnd,
          distributeEvenlyEnabled: settings.distributeEvenlyEnabled,
          roundRobinEnabled: settings.roundRobinEnabled,
        },
        source: {
          publishIntervalMinutes: source.publishIntervalMinutes,
          dailyLimit: source.dailyLimit,
          minPublishIntervalMinutes: source.minPublishIntervalMinutes,
          publishMode: source.publishMode,
          priority: source.priority,
          quietHoursStart: source.quietHoursStart,
          quietHoursEnd: source.quietHoursEnd,
        },
      }),
    )
    .digest('hex')
    .slice(0, 32);
}
