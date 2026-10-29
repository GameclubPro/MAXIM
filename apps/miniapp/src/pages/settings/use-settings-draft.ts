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
import type {
  ChatSettings,
  ChatSettingsScreenResponse,
  StopWordsState,
  StopWordsStorageStatus,
} from '@maxim/contracts/settings';
import type { UpdateBotSpeechStyleResponse } from '@maxim/contracts/bot-speech';
import type { ApiTransport } from '../../lib/api/transport';
import { patchSettingsSection } from '../../lib/api/chat-settings-client';
import { getStopWords } from '../../lib/api/stop-words-client';
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
import {
  mergeConfirmedStopWordsReceipt,
  rebaseSettingsAfterStopWordsSave,
  saveStopWordsSettings,
  saveWorkspaceSettings,
  type StopWordsReplacementAuthorization,
} from './settings-save-coordinator';

type SectionSave = {
  section: ApplySectionKey;
  payload: ChatSettings;
  recheckBotCapabilities?: boolean;
  replacement?: StopWordsReplacementAuthorization;
  storageStatus?: StopWordsStorageStatus;
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
  stopWordsStorageStatus?: StopWordsStorageStatus;
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
  const [stopWordsConflict, setStopWordsConflict] = useState(false);
  const [stopWordsSaveError, setStopWordsSaveError] = useState<string | null>(null);
  const [stopWordsState, setStopWordsState] = useState<StopWordsState | null>(null);
  const [stopWordsReplacement, setStopWordsReplacement] = useState<
    StopWordsReplacementAuthorization | undefined
  >();
  const stopWordsStorageStatus =
    stopWordsState && stopWordsState.revision >= (serverSettings?.stopWordsRevision ?? 0)
      ? stopWordsState.storageStatus
      : dependencies.stopWordsStorageStatus;
  const stopWordsReviewRef = useRef({
    status: stopWordsStorageStatus,
    revision: stopWordsState?.revision ?? serverSettings?.stopWordsRevision ?? 0,
  });
  stopWordsReviewRef.current = {
    status: stopWordsStorageStatus,
    revision: Math.max(stopWordsState?.revision ?? 0, serverSettings?.stopWordsRevision ?? 0),
  };
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
    setStopWordsConflict(false);
    setStopWordsSaveError(null);
    setStopWordsState(null);
    setStopWordsReplacement(undefined);
    return () => {
      if (active.current === identity) active.current = null;
    };
  }, [identity]);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (
      stopWordsReplacement &&
      serverSettings &&
      (serverSettings.stopWordsRevision ?? 0) > stopWordsReplacement.expectedRevision
    )
      setStopWordsReplacement(undefined);
  }, [serverSettings, stopWordsReplacement]);

  function authorizeStopWordsReplacement() {
    if (!isCurrentSettingsScope() || !chatId || stopWordsStorageStatus !== 'invalid') return;
    const revision =
      stopWordsState?.revision ??
      serverSettings?.stopWordsRevision ??
      draftRef.current?.stopWordsRevision ??
      0;
    if (
      stopWordsReviewRef.current.status !== 'invalid' ||
      stopWordsReviewRef.current.revision !== revision
    )
      return;
    setStopWordsReplacement({ chatId, expectedRevision: revision });
    setDraft((current) => (current ? { ...current, stopWordsRevision: revision } : current));
    setStopWordsSaveError(null);
  }
  function discardStopWordsEditorState() {
    if (!isCurrentSettingsScope()) return;
    setStopWordsReplacement(undefined);
    setStopWordsConflict(false);
    setStopWordsSaveError(null);
  }

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
  async function syncSavedStopWords(
    saved: StopWordsState,
    submitted: ChatSettings,
    baseline = serverSettings,
    sourceChatId = chatId,
    replaceDraft = false,
  ) {
    if (!isCurrentSettingsScope() || sourceChatId !== chatId) {
      void queryClient.invalidateQueries({
        queryKey: ['settings-screen', sourceChatId],
        refetchType: 'none',
      });
      return false;
    }
    const cached = queryClient.getQueryData<ChatSettingsScreenResponse>([
      'settings-screen',
      sourceChatId,
    ]);
    if (replaceDraft && (cached?.settings.stopWordsRevision ?? 0) > saved.revision) return false;
    setStopWordsState(saved);
    setStopWordsReplacement(undefined);
    setStopWordsConflict(false);
    setStopWordsSaveError(null);
    setDraft((current) =>
      current
        ? mergeConfirmedStopWordsReceipt({
            current,
            submitted: replaceDraft ? current : submitted,
            receipt: saved,
          })
        : current,
    );
    clearErrors(SECTION_SETTING_KEYS.stopWords);
    const queryKey = ['settings-screen', sourceChatId];
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(queryKey, (current) => {
      if (!current || (current.settings.stopWordsRevision ?? 0) > saved.revision) return current;
      return {
        ...current,
        stopWordsStorageStatus: saved.storageStatus,
        settings: mergeConfirmedStopWordsReceipt({
          current: current.settings,
          submitted: current.settings,
          receipt: saved,
        }),
      };
    });
    let newestScreen = queryClient.getQueryData<ChatSettingsScreenResponse>(queryKey);
    const revision = (screen: ChatSettingsScreenResponse | undefined) => {
      const value = Date.parse(screen?.settings.settingsRevision ?? '');
      return Number.isFinite(value) ? value : -Infinity;
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== queryKey[0] || event.query.queryKey[1] !== sourceChatId)
        return;
      const screen = event.query.state.data as ChatSettingsScreenResponse | undefined;
      if (screen && revision(screen) > revision(newestScreen)) newestScreen = screen;
    });
    try {
      const refreshed = await dependencies.refetchSettings();
      if (!isCurrentSettingsScope()) return;
      const screen =
        revision(newestScreen) > revision(refreshed.data) ? newestScreen : refreshed.data;
      if (screen && revision(screen) > revision(refreshed.data))
        queryClient.setQueryData(queryKey, screen);
      if (!screen || !baseline) return;
      setDraft((current) =>
        current
          ? rebaseSettingsAfterStopWordsSave({
              current,
              baseline: normalizeServerDraft(baseline),
              fresh: normalizeServerDraft(screen.settings),
              submitted,
              receipt: saved,
            })
          : current,
      );
      if ((screen.settings.stopWordsRevision ?? 0) >= saved.revision)
        setStopWordsState({
          ...saved,
          revision: screen.settings.stopWordsRevision ?? saved.revision,
          policy: screen.settings.stopWordsPolicy ?? saved.policy,
          storageStatus: screen.stopWordsStorageStatus ?? saved.storageStatus,
        });
    } catch {
      // FLAG: The stop policy is confirmed; an unavailable full refresh cannot promote its general fence.
    } finally {
      unsubscribe();
    }
    return true;
  }

  async function handleStopWordsSaveError(error: unknown) {
    if (!isCurrentSettingsScope() || !(error instanceof ApiRequestError)) return false;
    if (error.code === 'STOP_WORDS_REVISION_CONFLICT') {
      setStopWordsConflict(true);
      setStopWordsReplacement(undefined);
      setStopWordsSaveError(null);
      return true;
    }
    if (error.code !== 'STOP_WORDS_POLICY_REVIEW_REQUIRED') return false;
    setStopWordsReplacement(undefined);
    setStopWordsSaveError('Проверьте сохранённый список перед заменой.');
    const revision =
      typeof error.payload?.revision === 'number'
        ? error.payload.revision
        : (draftRef.current?.stopWordsRevision ?? 0);
    const policy = draftRef.current?.stopWordsPolicy;
    if (policy)
      setStopWordsState({
        policy,
        revision,
        storageStatus: 'invalid',
        imageScanStatus: 'unavailable',
      });
    try {
      const fresh = await getStopWords(api, chatId ?? '');
      if (!isCurrentSettingsScope()) return true;
      setStopWordsState(fresh);
      if (fresh.storageStatus !== 'invalid') setStopWordsConflict(true);
    } catch {
      // Preserve the draft and the review gate until the saved list can be checked.
    }
    return true;
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
        baseline: ChatSettings | undefined;
      },
    ) => {
      const { section, payload, recheckBotCapabilities } = request;
      const sourceChatId = request.identity.chatId ?? '';
      if (section === 'stopWords' && payload.stopWordsPolicy) {
        const receipt = await saveStopWordsSettings(api, {
          chatId: sourceChatId,
          draft: payload,
          storageStatus: request.storageStatus,
          replacement: request.replacement,
        });
        return { settings: payload, stopWords: receipt };
      }
      return {
        settings: await patchSettingsSection(
          api,
          sourceChatId,
          section,
          payload,
          SECTION_SETTING_KEYS[section],
          { recheckBotCapabilities },
        ),
        stopWords: undefined,
      };
    },
    onSuccess: async (result, request) => {
      const saved = result.settings;
      if (result.stopWords) {
        if (active.current !== request.identity) {
          void queryClient.invalidateQueries({
            queryKey: ['settings-screen', request.identity.chatId],
            refetchType: 'none',
          });
          return;
        }
        await syncSavedStopWords(
          result.stopWords,
          request.draftAtSubmission,
          request.baseline,
          request.identity.chatId,
        );
        if (active.current !== request.identity) return;
        pendingPermissionRetryRef.current = null;
        request.onStopWordsSaved();
        latest.current.onSaved(request.section);
        return;
      }
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
        if (active.current?.chatId === request.identity.chatId) {
          void queryClient.invalidateQueries({
            queryKey: ['settings-screen', request.identity.chatId],
            refetchType: 'none',
          });
          return;
        }
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
      latest.current.onSaved(request.section);
    },
    onError: async (error, request) => {
      if (active.current !== request.identity) return;
      if (request.section === 'stopWords') {
        await handleStopWordsSaveError(error);
        if (active.current !== request.identity) return;
        if (
          !(error instanceof ApiRequestError) ||
          !['STOP_WORDS_REVISION_CONFLICT', 'STOP_WORDS_POLICY_REVIEW_REQUIRED'].includes(
            error.code ?? '',
          )
        )
          setStopWordsSaveError('Не удалось сохранить список. Повторите попытку.');
      }
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
        baseline: latest.current.serverSettings,
        storageStatus: request.storageStatus ?? stopWordsStorageStatus,
        replacement: request.replacement ?? stopWordsReplacement,
      }),
    mutateAsync: (request: SectionSave) =>
      mutation.mutateAsync({
        ...request,
        identity,
        draftAtSubmission: draftRef.current ?? request.payload,
        onStopWordsSaved: latest.current.onStopWordsSaved,
        baseline: latest.current.serverSettings,
        storageStatus: request.storageStatus ?? stopWordsStorageStatus,
        replacement: request.replacement ?? stopWordsReplacement,
      }),
  };
  const workspaceMutation = useMutation({
    mutationFn: async (request: {
      payload: ChatSettings;
      identity: typeof identity;
      baseline: ChatSettings;
      replacement?: StopWordsReplacementAuthorization;
      storageStatus?: StopWordsStorageStatus;
    }) => {
      let baseline = request.baseline;
      return saveWorkspaceSettings(
        api,
        {
          chatId: request.identity.chatId ?? '',
          draft: request.payload,
          baseline,
          replacement: request.replacement,
          storageStatus: request.storageStatus,
        },
        async (progress) => {
          if (active.current !== request.identity) {
            void queryClient.invalidateQueries({
              queryKey: ['settings-screen', request.identity.chatId],
              refetchType: 'none',
            });
            return;
          }
          if (progress.kind === 'ordinary') {
            const saved = normalizeServerDraft(progress.saved);
            baseline = saved;
            const cached = queryClient.getQueryData<ChatSettingsScreenResponse>([
              'settings-screen',
              request.identity.chatId,
            ]);
            const cachedIsNewer =
              Date.parse(cached?.settings.settingsRevision ?? '') >
              Date.parse(saved.settingsRevision ?? '');
            setDraft((current) => {
              if (!current) return current;
              const next = { ...saved };
              for (const key of Object.keys(current) as Array<keyof ChatSettings>) {
                if (key === 'settingsRevision') continue;
                if (JSON.stringify(current[key]) !== JSON.stringify(progress.submitted[key]))
                  (next as Record<keyof ChatSettings, unknown>)[key] = current[key];
              }
              // FLAG: Even a full ordinary response cannot rebase an unsaved independent stop policy.
              if (
                JSON.stringify(progress.submitted.stopWordsPolicy) !==
                  JSON.stringify(request.baseline.stopWordsPolicy) ||
                JSON.stringify(current.stopWordsPolicy) !==
                  JSON.stringify(progress.submitted.stopWordsPolicy) ||
                request.replacement
              ) {
                next.stopWordsPolicy = current.stopWordsPolicy;
                next.stopWordsRevision = current.stopWordsRevision;
              }
              // FLAG: A delayed receipt cannot authorize drafts against a newer observed snapshot.
              if (cachedIsNewer) next.settingsRevision = current.settingsRevision;
              return next;
            });
            queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
              ['settings-screen', request.identity.chatId],
              (current) =>
                current &&
                Date.parse(current.settings.settingsRevision ?? '') >
                  Date.parse(saved.settingsRevision ?? '')
                  ? current
                  : current
                    ? { ...current, settings: saved }
                    : current,
            );
          } else {
            await syncSavedStopWords(
              progress.saved,
              progress.submitted,
              baseline,
              request.identity.chatId,
            );
            if (active.current === request.identity) latest.current.onStopWordsSaved();
          }
        },
      );
    },
    onError: async (error, request) => {
      if (active.current !== request.identity) return;
      await handleStopWordsSaveError(error);
    },
  });
  useLayoutEffect(() => {
    workspaceMutation.reset();
  }, [identity]);
  async function saveWorkspaceDraft(payload: ChatSettings) {
    if (!serverSettings) throw new Error('Настройки ещё не загружены.');
    await workspaceMutation.mutateAsync({
      payload,
      identity,
      baseline: normalizeServerDraft(serverSettings),
      replacement: stopWordsReplacement,
      storageStatus: stopWordsStorageStatus,
    });
    if (!isCurrentSettingsScope()) throw new Error('Чат изменился во время сохранения.');
  }

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
    syncSavedStopWords,
    stopWordsStorageStatus,
    stopWordsReplacement,
    authorizeStopWordsReplacement,
    discardStopWordsEditorState,
    stopWordsConflict,
    stopWordsSaveError,
    handleStopWordsSaveError,
    saveWorkspaceDraft,
    handleSettingsPermissionError,
    saveSectionMutation,
    isSavingSettings: mutation.isPending || workspaceMutation.isPending,
    savingSection: mutation.variables?.section ?? null,
    mutateSettingsAsync: saveSectionMutation.mutateAsync,
    isCurrentSettingsScope,
  };
}
