import type { ApplySettingsTarget, ChatSettings } from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import {
  applySettingsSectionToAll,
  patchSettingsSection,
} from '../../lib/api/chat-settings-client';
import { getStopWords, updateStopWords } from '../../lib/api/stop-words-client';
import { SECTION_SETTING_KEYS, type ApplySectionKey } from '../settings-page-state';

export type SettingsApplySubmission = {
  sourceChatId: string;
  confirmedTargetChatIds?: string[];
  section: ApplySectionKey;
  sourceSettings: ChatSettings;
  target: ApplySettingsTarget;
};

export type SettingsApplySavedSource = {
  sourceChatId: string;
  section: ApplySectionKey;
  settings: ChatSettings;
};

export async function applySettingsSectionWithConfirmedSource(
  api: ApiTransport,
  {
    section,
    sourceChatId,
    sourceSettings,
    target,
    confirmedTargetChatIds,
  }: SettingsApplySubmission,
  onSourceSaved: (saved: SettingsApplySavedSource | null) => void,
) {
  if (!sourceChatId) {
    throw new Error('Чат не выбран');
  }

  onSourceSaved(null);
  const savedStopWords =
    section === 'stopWords' && sourceSettings.stopWordsPolicy
      ? await updateStopWords(
          api,
          sourceChatId,
          sourceSettings.stopWordsPolicy,
          sourceSettings.stopWordsRevision ?? 0,
        )
      : null;
  const savedSourceSettings = savedStopWords
    ? {
        ...sourceSettings,
        stopWordsPolicy: savedStopWords.policy,
        stopWordsRevision: savedStopWords.revision,
      }
    : await patchSettingsSection(
        api,
        sourceChatId,
        section,
        sourceSettings,
        SECTION_SETTING_KEYS[section],
      );
  onSourceSaved({ sourceChatId, section, settings: savedSourceSettings });
  if (section === 'reports' && !savedSourceSettings.settingsRevision)
    throw new Error(
      'Не удалось подтвердить сохранённые настройки. Обновите экран перед применением.',
    );
  const result = await applySettingsSectionToAll(
    api,
    sourceChatId,
    section,
    target,
    savedStopWords?.revision,
    section === 'reports'
      ? {
          expectedSourceSettingsRevision: savedSourceSettings.settingsRevision!,
          confirmedTargetChatIds: confirmedTargetChatIds ?? [],
        }
      : undefined,
  );
  return {
    ...result,
    section,
    sourceSettings:
      savedStopWords && result.appliedChatIds.includes(sourceChatId)
        ? { ...savedSourceSettings, stopWordsRevision: savedStopWords.revision + 1 }
        : {
            ...savedSourceSettings,
            ...(result.sourceSettingsRevision
              ? { settingsRevision: result.sourceSettingsRevision }
              : {}),
          },
  };
}

export async function refreshSavedStopWordsSource(
  api: ApiTransport,
  savedSource: SettingsApplySavedSource,
): Promise<SettingsApplySavedSource> {
  try {
    const fresh = await getStopWords(api, savedSource.sourceChatId);
    return {
      ...savedSource,
      settings: {
        ...savedSource.settings,
        stopWordsPolicy: fresh.policy,
        stopWordsRevision: fresh.revision,
      },
    };
  } catch {
    // Preserve the last confirmed source snapshot on transport failure.
    return savedSource;
  }
}
