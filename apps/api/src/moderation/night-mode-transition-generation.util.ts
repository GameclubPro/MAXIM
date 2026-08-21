import { createHash } from 'node:crypto';
import type { ChatSettings } from '../prisma/prisma-client';
import type { NightModeTransitionScheduleSettings } from './night-mode-transition-time.util';

type NightModeSideEffectSettings = Pick<
  ChatSettings,
  | 'nightModeEnabled'
  | 'nightModeStartTimeMinutes'
  | 'nightModeEndTimeMinutes'
  | 'nightModeTimezone'
  | 'nightModeBotMessageEnabled'
  | 'nightModeBotMessageText'
  | 'nightModeCommentsEnabled'
  | 'nightModeOpenMessageEnabled'
  | 'nightModeOpenMessageText'
  | 'nightModeBotButtons'
  | 'nightModeBotButtonEnabled'
  | 'nightModeBotButtonUrl'
  | 'nightModeBotButtonText'
  | 'nightModeRulesButtonEnabled'
  | 'commentsEnabled'
  | 'botSpeechStyle'
  | 'botSpeechMedia'
> & {
  chat?: {
    entityType?: string | null;
    rules?: {
      publishedUrl?: string | null;
      publishedMessageId?: string | null;
    } | null;
  } | null;
};

export function buildNightModeTransitionScheduleFingerprint(
  settings: NightModeTransitionScheduleSettings,
): string {
  return hashGeneration([
    'night-mode-schedule:v1',
    settings.nightModeEnabled,
    settings.nightModeStartTimeMinutes,
    settings.nightModeEndTimeMinutes,
    settings.nightModeTimezone,
  ]);
}

export function buildNightModeTransitionSideEffectFingerprint(
  settings: NightModeSideEffectSettings,
): string {
  return hashGeneration([
    'night-mode-side-effects:v1',
    settings.nightModeEnabled,
    settings.nightModeStartTimeMinutes,
    settings.nightModeEndTimeMinutes,
    settings.nightModeTimezone,
    settings.nightModeBotMessageEnabled,
    settings.nightModeBotMessageText,
    settings.nightModeCommentsEnabled,
    settings.nightModeOpenMessageEnabled,
    settings.nightModeOpenMessageText,
    settings.nightModeBotButtons,
    settings.nightModeBotButtonEnabled,
    settings.nightModeBotButtonUrl,
    settings.nightModeBotButtonText,
    settings.nightModeRulesButtonEnabled,
    settings.commentsEnabled,
    settings.botSpeechStyle,
    settings.botSpeechMedia,
    settings.chat?.entityType ?? null,
    settings.chat?.rules?.publishedUrl ?? null,
    settings.chat?.rules?.publishedMessageId ?? null,
  ]);
}

function hashGeneration(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
