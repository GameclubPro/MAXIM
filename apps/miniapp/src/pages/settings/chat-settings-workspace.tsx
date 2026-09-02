import type {
  ChatRules,
  ChatSettings,
  ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import type { ManagedEntityHeader } from '@maxim/contracts/managed-entities';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { useLocation } from 'react-router';
import { ManagedEntityWorkspaceHeader } from '../../components/ui/managed-entity-workspace-header';
import { useToast } from '../../components/ui/toast';
import { updateSettings } from '../../lib/api/chat-settings-client';
import type { ApiTransport } from '../../lib/api/transport';
import { maxNotify, setMaxClosingConfirmation } from '../../lib/max-bridge';
import { useManagedEntityLeaveGuard } from '../../lib/managed-entity-navigation';
import {
  buildManagedEntityStatisticsRoute,
  readManagedEntityWorkspaceState,
} from '../../lib/managed-entity-workspace';
import {
  formatApiError,
  normalizeDuplicateFlowSettings,
  normalizeLegacyChatCommentScope,
} from './settings-page-helpers';
import { normalizeRequiredSubscriptionDraftSettings } from '../settings-page-state';

function normalizeWorkspaceDraft(settings: ChatSettings): ChatSettings {
  return normalizeDuplicateFlowSettings(
    normalizeLegacyChatCommentScope(normalizeRequiredSubscriptionDraftSettings(settings)),
  );
}

type ChatSettingsWorkspaceLeaveGuardOptions = {
  api: ApiTransport;
  chatId: string | undefined;
  draft: ChatSettings | null;
  serverSettings: ChatSettings | undefined;
  serverRules: ChatRules | undefined;
  settingsDirty: boolean;
  rulesDirty: boolean;
  saving: boolean;
  validateDraft: (draft: ChatSettings) => ChatSettings | null;
  saveRules: () => Promise<ChatRules | null>;
  setDraft: Dispatch<SetStateAction<ChatSettings | null>>;
  setRulesDraft: Dispatch<SetStateAction<ChatRules | null>>;
  clearValidationErrors: () => void;
  onSettingsSaveError?: (error: unknown) => boolean | Promise<boolean>;
};

export function useChatSettingsWorkspaceLeaveGuard({
  api,
  chatId,
  draft,
  serverSettings,
  serverRules,
  settingsDirty,
  rulesDirty,
  saving,
  validateDraft,
  saveRules,
  setDraft,
  setRulesDraft,
  clearValidationErrors,
  onSettingsSaveError,
}: ChatSettingsWorkspaceLeaveGuardOptions): void {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const dirty = settingsDirty || rulesDirty;

  useEffect(() => {
    setMaxClosingConfirmation(dirty || saving);
    return () => setMaxClosingConfirmation(false);
  }, [dirty, saving]);

  useManagedEntityLeaveGuard({
    dirty,
    saving,
    save: async () => {
      if (!chatId) {
        return false;
      }

      try {
        if (settingsDirty) {
          if (!draft) {
            return false;
          }
          const payload = validateDraft(draft);
          if (!payload) {
            pushToast({ tone: 'danger', title: 'Исправьте настройки перед переходом' });
            return false;
          }

          const saved = await updateSettings(api, chatId, payload);
          setDraft(normalizeWorkspaceDraft(saved));
          queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
            ['settings-screen', chatId],
            (current) => (current ? { ...current, settings: saved } : current),
          );
        }

        if (rulesDirty && !(await saveRules())) {
          return false;
        }

        return true;
      } catch (error: unknown) {
        if (await onSettingsSaveError?.(error)) {
          maxNotify('error');
          return false;
        }
        pushToast({
          tone: 'danger',
          title: 'Не удалось сохранить изменения',
          description: formatApiError(error),
        });
        maxNotify('error');
        return false;
      }
    },
    discard: () => {
      if (serverSettings) {
        setDraft(normalizeWorkspaceDraft(serverSettings));
      }
      if (serverRules) {
        setRulesDraft(serverRules);
      }
      clearValidationErrors();
    },
  });
}

type ChatSettingsWorkspaceHeaderProps = {
  chatId: string | undefined;
  title: string;
  header: Pick<ManagedEntityHeader, 'title' | 'avatarUrl'> | null | undefined;
  fallbackAvatarUrl: string | null;
  backTo: string;
  counterpartHidden: boolean;
  compact: boolean;
};

export function ChatSettingsWorkspaceHeader({
  chatId,
  title,
  header,
  fallbackAvatarUrl,
  backTo,
  counterpartHidden,
  compact,
}: ChatSettingsWorkspaceHeaderProps) {
  const location = useLocation();

  return (
    <ManagedEntityWorkspaceHeader
      entityType="chat"
      screen="settings"
      title={title}
      avatarUrl={header ? (header.avatarUrl ?? null) : fallbackAvatarUrl}
      authoritativeIdentity={
        header ? { title: header.title, avatarUrl: header.avatarUrl ?? null } : undefined
      }
      backTo={backTo}
      counterpartTo={
        chatId
          ? buildManagedEntityStatisticsRoute(
              'chat',
              chatId,
              readManagedEntityWorkspaceState(location.state)?.statsPreference,
            )
          : backTo
      }
      counterpartHidden={counterpartHidden}
      compact={compact}
      className="settings-home-sticky-header"
    />
  );
}
