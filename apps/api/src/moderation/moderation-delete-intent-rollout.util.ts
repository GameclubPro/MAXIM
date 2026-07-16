import type {
  ModerationDeleteIntentMode,
  ModerationDeleteIntentRollout,
} from './moderation-delete-intent.types';

export function normalizeModerationDeleteIntentMode(value: unknown): ModerationDeleteIntentMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'off' ||
    normalized === 'shadow' ||
    normalized === 'canary' ||
    normalized === 'on'
    ? normalized
    : 'off';
}

export function parseModerationDeleteIntentCanaryChatIds(value: unknown): ReadonlySet<string> {
  const raw = typeof value === 'string' ? value : '';
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function resolveModerationDeleteIntentRollout(params: {
  mode: ModerationDeleteIntentMode;
  canaryChatIds: ReadonlySet<string>;
  chatId: string;
}): ModerationDeleteIntentRollout {
  if (params.mode === 'off') {
    return 'off';
  }
  if (params.mode === 'shadow') {
    return 'observed';
  }
  if (params.mode === 'on') {
    return 'execute';
  }

  const chatId = params.chatId.trim();
  return chatId && (params.canaryChatIds.has('*') || params.canaryChatIds.has(chatId))
    ? 'execute'
    : 'observed';
}
