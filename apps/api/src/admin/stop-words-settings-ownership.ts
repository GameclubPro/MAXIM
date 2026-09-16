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
  if (!requested || typeof requested !== 'object') return;
  const body = requested as Record<string, unknown>;
  if (
    LEGACY_STOP_WORD_SETTING_KEYS.some(
      (key) =>
        Object.hasOwn(body, key) &&
        JSON.stringify(body[key]) !==
          JSON.stringify(
            current[key] ?? (key === 'messageLimitsImageTextScanEnabled' ? false : []),
          ),
    )
  ) {
    throw new ConflictException({
      code: 'STOP_WORDS_LEGACY_WRITE',
      message: 'Откройте обновлённый раздел «Стоп-слова» для изменения списка.',
    });
  }
}

export function omitLegacyStopWordsSettings<T extends Partial<ChatSettings>>(
  settings: T,
): Omit<T, (typeof LEGACY_STOP_WORD_SETTING_KEYS)[number]> {
  const result = { ...settings };
  for (const key of LEGACY_STOP_WORD_SETTING_KEYS) delete result[key];
  return result;
}
