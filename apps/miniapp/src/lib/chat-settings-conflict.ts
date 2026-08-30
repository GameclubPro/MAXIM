import { ApiRequestError } from './api-request-error';

export type ChatSettingsConcurrentUpdate = {
  partialApplied: boolean;
  appliedCount: number;
};

export type ChatSettingsConcurrentUpdatePresentation = {
  title: string;
  description: string;
};

export function parseChatSettingsConcurrentUpdate(
  error: unknown,
): ChatSettingsConcurrentUpdate | null {
  if (
    !(error instanceof ApiRequestError) ||
    error.status !== 409 ||
    error.code !== 'CHAT_SETTINGS_CONCURRENT_UPDATE'
  ) {
    return null;
  }

  const payloadCount = error.payload?.appliedCount;
  const sampledIds = error.payload?.appliedChatIds;
  const appliedCount =
    typeof payloadCount === 'number' && Number.isSafeInteger(payloadCount) && payloadCount >= 0
      ? payloadCount
      : Array.isArray(sampledIds)
        ? sampledIds.filter((item) => typeof item === 'string').length
        : 0;

  return {
    partialApplied: error.payload?.partialApplied === true || appliedCount > 0,
    appliedCount,
  };
}

export function getChatSettingsConcurrentUpdatePresentation(
  error: unknown,
): ChatSettingsConcurrentUpdatePresentation | null {
  const update = parseChatSettingsConcurrentUpdate(error);
  if (!update) {
    return null;
  }

  return update.partialApplied
    ? {
        title: 'Часть настроек уже применена',
        description: `Обновлено чатов: ${update.appliedCount}. Проверьте результат перед повтором.`,
      }
    : {
        title: 'Настройки изменились параллельно',
        description: 'Повторите применение после обновления данных.',
      };
}
