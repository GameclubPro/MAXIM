import type { BotPermissionBlocker } from './bot-permission-error';
import { parseBotPermissionBlocker, revertRejectedFeatureChanges } from './bot-permission-error';
import { getChatSettingsConcurrentUpdatePresentation } from './chat-settings-conflict';

export type ChatSettingsSaveErrorResolution<T extends object> =
  | {
      kind: 'permission';
      blocker: BotPermissionBlocker;
      revert: ((draft: T) => T) | null;
    }
  | {
      kind: 'concurrent';
      title: string;
      description: string;
    };

export function resolveChatSettingsSaveError<T extends object>(
  error: unknown,
  persisted: T | null,
  scopeKeys?: readonly (keyof T)[],
  canRecheck = false,
): ChatSettingsSaveErrorResolution<T> | null {
  const parsed = parseBotPermissionBlocker(error);
  if (parsed) {
    return {
      kind: 'permission',
      blocker: canRecheck ? parsed : { ...parsed, canRecheck: false },
      revert: persisted
        ? (draft) => revertRejectedFeatureChanges(draft, persisted, scopeKeys, parsed.features)
        : null,
    };
  }

  const concurrent = getChatSettingsConcurrentUpdatePresentation(error);
  return concurrent ? { kind: 'concurrent', ...concurrent } : null;
}
