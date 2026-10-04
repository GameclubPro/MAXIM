import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ChatSettings, ChatSettingsScreenResponse } from '@maxim/contracts/settings';
import type { UpdateBotSpeechStyleResponse } from '@maxim/contracts/bot-speech';
import type { ApiTransport } from '../../lib/api/transport';
import { patchSettingsSection } from '../../lib/api/chat-settings-client';
import { updateStopWords } from '../../lib/api/stop-words-client';
import { ApiRequestError } from '../../lib/api-request-error';
import type { BotPermissionBlocker } from '../../lib/bot-permission-error';
import {
  BOT_SPEECH_SYNC_SETTING_KEYS,
  SECTION_SETTING_KEYS,
  type ApplySectionKey,
  mergeBotSpeechStyleSettings,
  rebaseSettingsAfterBotSpeechStyleSave,
  mergeSectionSettings,
  mergeSectionSettingsAfterSave,
  normalizeRequiredSubscriptionDraftSettings,
  serializeChatSettingsDraft,
  shouldHydrateSettingsDraftFromServer,
} from '../settings-page-state';
import {
  normalizeDuplicateFlowSettings,
  normalizeLegacyChatCommentScope,
  type FieldErrors,
} from './settings-page-helpers';

type SectionSave = {
  section: ApplySectionKey;
  payload: ChatSettings;
  recheckBotCapabilities?: boolean;
};
type SettingsConflict = {
  section: ApplySectionKey;
  saved: ChatSettings;
  draft: ChatSettings;
  viewingSaved: boolean;
};
type Dependencies = {
  api: ApiTransport;
  chatId: string | undefined;
  userId?: string | null;
  serverSettings: ChatSettings | undefined;
  refetchSettings(): Promise<{ data?: ChatSettingsScreenResponse }>;
  onHydrated(): void;
  onStopWordsSaved(): void;
  onSaved(section: ApplySectionKey): void;
  onError(error: unknown, section: ApplySectionKey, permission: boolean): void;
};

function normalizeServerDraft(settings: ChatSettings) {
  return normalizeDuplicateFlowSettings(
    normalizeLegacyChatCommentScope(normalizeRequiredSubscriptionDraftSettings(settings)),
  );
}

export function useSettingsDraft(dependencies: Dependencies) {
  const { api, chatId, serverSettings } = dependencies;
  const queryClient = useQueryClient();
  const latest = useRef(dependencies);
  latest.current = dependencies;
  const identity = useMemo(
    () => ({ chatId, userId: dependencies.userId }),
    [chatId, dependencies.userId],
  );
  const active = useRef<typeof identity | null>(identity);
  active.current = identity;
  const [draft, setOwnedDraft] = useState<ChatSettings | null>(null);
  const draftRef = useRef(draft);
  const previousSettingsServerSnapshotRef = useRef('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [permissionBlocker, setPermissionBlocker] = useState<BotPermissionBlocker | null>(null);
  const pendingPermissionRetryRef = useRef<SectionSave | null>(null);
  const [settingsConflict, setSettingsConflict] = useState<SettingsConflict | null>(null);
  const isCurrentSettingsScope = () => active.current === identity;
  // FLAG: Async callers retain the setter for their original chat, even after leaving and returning.
  const setDraft: Dispatch<SetStateAction<ChatSettings | null>> = (update) => {
    if (!isCurrentSettingsScope()) return;
    setOwnedDraft((current) =>
      isCurrentSettingsScope()
        ? typeof update === 'function'
          ? update(current)
          : update
        : current,
    );
  };

  useLayoutEffect(() => {
    active.current = identity;
    setOwnedDraft(null);
    draftRef.current = null;
    previousSettingsServerSnapshotRef.current = '';
    setFieldErrors({});
    setPermissionBlocker(null);
    pendingPermissionRetryRef.current = null;
    setSettingsConflict(null);
    return () => {
      if (active.current === identity) active.current = null;
    };
  }, [identity]);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!serverSettings) return;
    const nextServerDraft = normalizeServerDraft(serverSettings);
    const nextServerSnapshot = serializeChatSettingsDraft(nextServerDraft);
    const shouldHydrate = shouldHydrateSettingsDraftFromServer(
      draftRef.current ? serializeChatSettingsDraft(draftRef.current) : '',
      previousSettingsServerSnapshotRef.current,
      nextServerSnapshot,
    );
    previousSettingsServerSnapshotRef.current = nextServerSnapshot;
    if (!shouldHydrate) return;
    setDraft(nextServerDraft);
    setFieldErrors({});
    latest.current.onHydrated();
  }, [serverSettings, identity]);

  const draftSnapshot = useMemo(() => (draft ? serializeChatSettingsDraft(draft) : ''), [draft]);
  const serverSnapshot = useMemo(
    () => (serverSettings ? serializeChatSettingsDraft(normalizeServerDraft(serverSettings)) : ''),
    [serverSettings],
  );
  const hasChanges = Boolean(draft && serverSettings && draftSnapshot !== serverSnapshot);

  async function handleSettingsPermissionError(
    error: unknown,
    section: ApplySectionKey | null,
    retry?: SectionSave,
  ): Promise<boolean> {
    const { resolveChatSettingsSaveError } = await import('../../lib/chat-settings-save-error');
    if (!isCurrentSettingsScope()) return false;
    const persisted = latest.current.serverSettings;
    const resolution = resolveChatSettingsSaveError(
      error,
      persisted ? normalizeRequiredSubscriptionDraftSettings(persisted) : null,
      section ? SECTION_SETTING_KEYS[section] : undefined,
      retry !== undefined,
    );
    if (resolution?.kind !== 'permission' || !resolution.revert) return false;
    setDraft((current) => (current ? (resolution.revert?.(current) ?? current) : current));
    pendingPermissionRetryRef.current = retry ?? null;
    setPermissionBlocker(resolution.blocker);
    return true;
  }

  function clearFieldError(key: keyof ChatSettings) {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  function clearErrors(keys: readonly (keyof ChatSettings)[]) {
    setFieldErrors((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of keys) {
        if (!next[key]) continue;
        delete next[key];
        changed = true;
      }
      return changed ? next : current;
    });
  }

  function syncSavedSectionSettings(
    section: ApplySectionKey,
    saved: ChatSettings,
    expectedRevision?: string,
    sourceChatId = chatId,
    submittedSettings?: ChatSettings,
  ) {
    const normalizedSaved = normalizeRequiredSubscriptionDraftSettings(saved);
    if (isCurrentSettingsScope() && chatId === sourceChatId) {
      setDraft((current) =>
        current
          ? mergeSectionSettingsAfterSave(
              current,
              normalizedSaved,
              section,
              expectedRevision,
              submittedSettings,
            )
          : normalizedSaved,
      );
      clearErrors(SECTION_SETTING_KEYS[section]);
    }
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', sourceChatId],
      (current) =>
        current &&
        Date.parse(current.settings.settingsRevision ?? '') >
          Date.parse(normalizedSaved.settingsRevision ?? '')
          ? current
          : current
            ? {
                ...current,
                settings:
                  section === 'stopWords'
                    ? mergeSectionSettings(
                        normalizeRequiredSubscriptionDraftSettings(current.settings),
                        normalizedSaved,
                        section,
                      )
                    : normalizedSaved,
              }
            : current,
    );
  }
  async function syncSavedBotSpeechStyle(saved: UpdateBotSpeechStyleResponse) {
    const isNewerThanReceipt = (settings: ChatSettings) =>
      Date.parse(settings.settingsRevision ?? '') > Date.parse(saved.settingsRevision);
    if (isCurrentSettingsScope()) {
      setDraft((current) =>
        current && !isNewerThanReceipt(current)
          ? mergeBotSpeechStyleSettings(current, saved)
          : current,
      );
      clearErrors(BOT_SPEECH_SYNC_SETTING_KEYS);
    }
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', chatId],
      (current) =>
        current && !isNewerThanReceipt(current.settings)
          ? { ...current, settings: mergeBotSpeechStyleSettings(current.settings, saved) }
          : current,
    );

    if (!isCurrentSettingsScope()) {
      void queryClient.invalidateQueries({
        queryKey: ['settings-screen', chatId],
        refetchType: 'none',
      });
      return;
    }

    // FLAG: Keep the original revision until a complete refreshed snapshot can be rebased safely.
    const queryKey = ['settings-screen', chatId];
    let newestScreen = queryClient.getQueryData<ChatSettingsScreenResponse>(queryKey);
    const revision = (screen: ChatSettingsScreenResponse | undefined) => {
      const value = Date.parse(screen?.settings.settingsRevision ?? '');
      return Number.isFinite(value) ? value : -Infinity;
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== queryKey[0] || event.query.queryKey[1] !== chatId) return;
      const screen = event.query.state.data as ChatSettingsScreenResponse | undefined;
      if (screen && revision(screen) > revision(newestScreen)) newestScreen = screen;
    });
    try {
      const refreshed = await dependencies.refetchSettings();
      const received = refreshed.data;
      if (newestScreen && revision(newestScreen) > revision(received))
        queryClient.setQueryData(queryKey, newestScreen);
      const fresh = (revision(newestScreen) > revision(received) ? newestScreen : received)
        ?.settings;
      const freshRevision = Date.parse(fresh?.settingsRevision ?? '');
      if (
        !isCurrentSettingsScope() ||
        !serverSettings ||
        !fresh ||
        !Number.isFinite(freshRevision) ||
        freshRevision < Date.parse(saved.settingsRevision)
      )
        return;
      setDraft((current) =>
        current && !isNewerThanReceipt(current)
          ? rebaseSettingsAfterBotSpeechStyleSave(
              current,
              normalizeServerDraft(serverSettings),
              normalizeServerDraft(fresh),
            )
          : current,
      );
    } catch {
      // The style is saved; the original revision still protects drafts until refresh succeeds.
    } finally {
      unsubscribe();
    }
  }

  const mutation = useMutation({
    mutationFn: async (
      request: SectionSave & {
        identity: typeof identity;
        draftAtSubmission: ChatSettings;
        onStopWordsSaved: () => void;
      },
    ) => {
      const { section, payload, recheckBotCapabilities } = request;
      const sourceChatId = request.identity.chatId ?? '';
      if (section === 'stopWords' && payload.stopWordsPolicy) {
        const saved = await updateStopWords(
          api,
          sourceChatId,
          payload.stopWordsPolicy,
          payload.stopWordsRevision ?? 0,
        );
        return { ...payload, stopWordsPolicy: saved.policy, stopWordsRevision: saved.revision };
      }
      return patchSettingsSection(
        api,
        sourceChatId,
        section,
        payload,
        SECTION_SETTING_KEYS[section],
        { recheckBotCapabilities },
      );
    },
    onSuccess: (saved, request) => {
      if (request.section === 'duplicates') {
        // FLAG: Refresh only the saved request's chat, including a late receipt after navigation.
        void queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            queryKey[0] === 'duplicate-diagnostics' &&
            queryKey[2] === request.identity.chatId &&
            (request.identity.userId === undefined || queryKey[1] === request.identity.userId),
        });
      }
      // FLAG: Cache the original chat result; stale replies never mutate the current draft or dialogs.
      if (active.current !== request.identity) {
        queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
          ['settings-screen', request.identity.chatId],
          (current) => {
            if (
              !current ||
              Date.parse(current.settings.settingsRevision ?? '') >
                Date.parse(saved.settingsRevision ?? '')
            )
              return current;
            return {
              ...current,
              settings:
                request.section === 'stopWords'
                  ? mergeSectionSettings(current.settings, saved, request.section)
                  : saved,
            };
          },
        );
        return;
      }
      setSettingsConflict(null);
      pendingPermissionRetryRef.current = null;
      syncSavedSectionSettings(
        request.section,
        saved,
        request.payload.settingsRevision,
        request.identity.chatId,
        request.draftAtSubmission,
      );
      if (request.section === 'stopWords') {
        request.onStopWordsSaved();
        void latest.current.refetchSettings();
      }
      latest.current.onSaved(request.section);
    },
    onError: async (error, request) => {
      if (active.current !== request.identity) return;
      if (error instanceof ApiRequestError && error.code === 'CHAT_SETTINGS_CONCURRENT_UPDATE') {
        const fresh = await latest.current.refetchSettings();
        if (active.current !== request.identity) return;
        if (fresh.data)
          setSettingsConflict({
            section: request.section,
            saved: fresh.data.settings,
            draft: draftRef.current ?? request.payload,
            viewingSaved: false,
          });
      }
      const permission = await handleSettingsPermissionError(error, request.section, request);
      if (active.current !== request.identity) return;
      if (!permission) pendingPermissionRetryRef.current = null;
      latest.current.onError(error, request.section, permission);
    },
  });
  useLayoutEffect(() => {
    mutation.reset();
  }, [identity]);
  const saveSectionMutation = {
    isPending: mutation.isPending,
    variables: mutation.variables,
    mutate: (request: SectionSave) =>
      mutation.mutate({
        ...request,
        identity,
        draftAtSubmission: draftRef.current ?? request.payload,
        onStopWordsSaved: latest.current.onStopWordsSaved,
      }),
    mutateAsync: (request: SectionSave) =>
      mutation.mutateAsync({
        ...request,
        identity,
        draftAtSubmission: draftRef.current ?? request.payload,
        onStopWordsSaved: latest.current.onStopWordsSaved,
      }),
  };
  return {
    draft,
    setDraft,
    fieldErrors,
    setFieldErrors,
    permissionBlocker,
    setPermissionBlocker,
    pendingPermissionRetryRef,
    settingsConflict,
    setSettingsConflict,
    hasChanges,
    clearFieldError,
    syncSavedSectionSettings,
    syncSavedBotSpeechStyle,
    handleSettingsPermissionError,
    saveSectionMutation,
    isSavingSettings: mutation.isPending,
    savingSection: mutation.variables?.section ?? null,
    mutateSettingsAsync: saveSectionMutation.mutateAsync,
    isCurrentSettingsScope,
  };
}
