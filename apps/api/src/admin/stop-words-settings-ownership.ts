import { ConflictException } from '@nestjs/common';
import type { ChatSettings } from '@maxim/contracts/settings';

export const LEGACY_STOP_WORD_SETTING_KEYS = [
  'messageLimitsBlockedWords',
  'messageLimitsBlockedDomains',
  'messageLimitsImageTextScanEnabled',
] as const;

export function omitStopWordsPolicy<T extends Partial<ChatSettings>>(
  settings: T,
): Omit<T, 'stopWordsPolicy' | 'stopWordsRevision'> {
  const rest = { ...settings };
  delete rest.stopWordsPolicy;
  delete rest.stopWordsRevision;
  return rest;
}

export function assertLegacyStopWordsWrite(
  current: { stopWordsPolicy?: unknown } & Partial<
    Pick<ChatSettings, (typeof LEGACY_STOP_WORD_SETTING_KEYS)[number]>
  >,
  requested: unknown,
): void {
  if (current.stopWordsPolicy == null || !requested || typeof requested !== 'object') return;
  const body = requested as Record<string, unknown>;
  if (
    LEGACY_STOP_WORD_SETTING_KEYS.some(
      (key) =>
        Object.hasOwn(body, key) && JSON.stringify(body[key]) !== JSON.stringify(current[key]),
    )
  ) {
    throw new ConflictException({
      code: 'STOP_WORDS_LEGACY_WRITE',
      message: 'Откройте обновлённый раздел «Стоп-слова» для изменения списка.',
    });
  }
}

export function hasLegacyStopWordsChanges(
  current: Partial<Pick<ChatSettings, (typeof LEGACY_STOP_WORD_SETTING_KEYS)[number]>>,
  next: Partial<ChatSettings>,
): boolean {
  return LEGACY_STOP_WORD_SETTING_KEYS.some(
    (key) => Object.hasOwn(next, key) && JSON.stringify(next[key]) !== JSON.stringify(current[key]),
  );
}
