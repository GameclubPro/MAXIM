import { createHash } from 'node:crypto';
import type { ChatSettings } from '../prisma/prisma-client';
import type { ModerationMediaFlags } from './moderation-update-extractors';

export const TRAFFIC_PROTECTION_RULE_CODES = [
  'SLOW_MODE',
  'MEDIA_RATE_LIMIT',
  'STICKER_BLOCKED',
] as const;
export type TrafficProtectionRule = (typeof TRAFFIC_PROTECTION_RULE_CODES)[number];
export const TRAFFIC_PROTECTION_DELETE_RULE_CODES = new Set(
  TRAFFIC_PROTECTION_RULE_CODES.map((rule) => `${rule}_DELETE`),
);
export const TRAFFIC_PROTECTION_SETTINGS_KEYS = [
  'slowModeEnabled',
  'slowModeIntervalSeconds',
  'mediaMessageCooldownEnabled',
  'mediaMessageCooldownSeconds',
  'stickerMessagesEnabled',
] as const;
export const TRAFFIC_PROTECTION_MAX_DELETE_AGE_MS = 5 * 60 * 1000;

export type TrafficProtectionSettings = Pick<
  ChatSettings,
  (typeof TRAFFIC_PROTECTION_SETTINGS_KEYS)[number] | 'trafficPolicyRevision'
> & { trafficPolicyEffectiveAt: Date | string };

export function trafficPolicyEffectiveAtMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : NaN;
}

export function isTrafficProtectionViolation(ruleCode: string): boolean {
  return TRAFFIC_PROTECTION_RULE_CODES.some((rule) => rule === ruleCode);
}

export function fingerprintTrafficSource(text: string, media: Partial<ModerationMediaFlags>) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        text,
        Boolean(media.hasPhotoAttachment),
        Boolean(media.hasStickerAttachment),
        Boolean(media.hasVideoAttachment),
        Boolean(media.hasFileAttachment),
        Boolean(media.hasVoiceAttachment),
      ]),
    )
    .digest('hex');
}

export function hasTrafficMedia(media: Partial<ModerationMediaFlags>): boolean {
  return Boolean(
    media.hasPhotoAttachment ||
    media.hasStickerAttachment ||
    media.hasVideoAttachment ||
    media.hasFileAttachment ||
    media.hasVoiceAttachment,
  );
}

export function trafficRuleInterval(
  rule: TrafficProtectionRule,
  settings: TrafficProtectionSettings,
): number | null {
  if (rule === 'STICKER_BLOCKED') return settings.stickerMessagesEnabled === false ? 300 : null;
  const enabled =
    rule === 'SLOW_MODE' ? settings.slowModeEnabled : settings.mediaMessageCooldownEnabled;
  const seconds =
    rule === 'SLOW_MODE' ? settings.slowModeIntervalSeconds : settings.mediaMessageCooldownSeconds;
  return enabled && Number.isSafeInteger(seconds) && seconds >= 10 && seconds <= 86400
    ? seconds
    : null;
}
