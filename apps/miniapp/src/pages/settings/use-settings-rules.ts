import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  chatRulesSchema,
  MAX_CHAT_RULES_TEXT_LENGTH,
  type ChatRules,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import type { UpdateChatRulesPayload } from '../../lib/api/shared-types';
import { updateRules, publishRules, resetPublishedRules } from '../../lib/api/chat-settings-client';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  hasBroadcastLinkButtonErrors,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../../lib/broadcast-link-buttons';
import { maxNotify } from '../../lib/max-bridge';
import type { useToast } from '../../components/ui/toast';
import {
  buildRulesTextFromSettingsScreen,
  getRulesPublicationFeedback,
  type RulesPublicationMode,
  mergeSavedRulesIntoSettingsScreen,
  runRulesSaveAttempt,
  serializeRulesDraftPayload,
  shouldHydrateRulesDraftFromServer,
} from '../settings-rules-state';
import {
  formatApiError,
  AUTO_SAVE_DELAY_MS,
  DEFAULT_RULES_POST_BUTTON_TEXT,
} from './settings-page-helpers';
type Dependencies = {
  api: ApiTransport;
  chatId: string | undefined;
  serverRules: ChatRules | undefined;
  currentRulesTextSource: Parameters<typeof buildRulesTextFromSettingsScreen>[0] | null;
  isUpdatingRulesAttachment: boolean;
  pushToast: ReturnType<typeof useToast>['pushToast'];
};
export function useSettingsRules({
  api,
  chatId,
  serverRules,
  currentRulesTextSource,
  isUpdatingRulesAttachment,
  pushToast,
}: Dependencies) {
  const queryClient = useQueryClient();
  const identity = useMemo(() => ({ chatId }), [chatId]);
  const active = useRef<typeof identity | null>(identity);
  active.current = identity;
  const isCurrentRulesScope = () => active.current === identity;
  const [rulesDraft, setOwnedRulesDraft] = useState<ChatRules | null>(null);
  // FLAG: Save, image and leave-guard callbacks are bound to one visit, including revisits.
  const setRulesDraft: Dispatch<SetStateAction<ChatRules | null>> = (update) => {
    if (!isCurrentRulesScope()) return;
    setOwnedRulesDraft((current) =>
      !isCurrentRulesScope() ? current : typeof update === 'function' ? update(current) : update,
    );
  };
  const [rulesPublicationMode, setRulesPublicationMode] =
    useState<RulesPublicationMode>('new_message');
  const [rulesTextError, setRulesTextError] = useState('');
  const [rulesImageError, setRulesImageError] = useState('');
  const [isPreparingRulesImage, setIsPreparingRulesImage] = useState(false);
  const rulesImagePreparingRef = useRef(false);
  const [rulesButtonErrors, setRulesButtonErrors] = useState<BroadcastLinkButtonFieldErrors[]>([]);
  const [rulesButtonFieldsTouched, setRulesButtonFieldsTouched] = useState(false);
  const [rulesButtonsSheetOpen, setRulesButtonsSheetOpen] = useState(false);
  const [rulesButtonRevealSignal, setRulesButtonRevealSignal] = useState(0);
  const [rulesResetConfirmationOpen, setRulesResetConfirmationOpen] = useState(false);
  const [rulesFailedSnapshot, setRulesFailedSnapshot] = useState('');
  const [isPreparingRulesPublish, setIsPreparingRulesPublish] = useState(false);
  const rulesDraftRef = useRef<ChatRules | null>(null);
  const previousRulesServerSnapshotRef = useRef('');
  useLayoutEffect(() => {
    rulesDraftRef.current = rulesDraft;
  }, [rulesDraft]);

  useLayoutEffect(() => {
    active.current = identity;
    setOwnedRulesDraft(null);
    rulesDraftRef.current = null;
    previousRulesServerSnapshotRef.current = '';
    rulesImagePreparingRef.current = false;
    setIsPreparingRulesImage(false);
    setRulesPublicationMode('new_message');
    setRulesTextError('');
    setRulesImageError('');
    setRulesButtonErrors([]);
    setRulesButtonFieldsTouched(false);
    setRulesButtonsSheetOpen(false);
    setRulesButtonRevealSignal(0);
    setRulesFailedSnapshot('');
    setIsPreparingRulesPublish(false);
    setRulesResetConfirmationOpen(false);
    saveRulesMutation.reset();
    publishRulesMutation.reset();
    resetPublishedRulesMutation.reset();
    return () => {
      if (active.current === identity) active.current = null;
    };
  }, [identity]);

  function handleRulesImagePreparationChange(preparing: boolean) {
    if (!isCurrentRulesScope()) return;
    rulesImagePreparingRef.current = preparing;
    setIsPreparingRulesImage(preparing);
    if (preparing) setRulesImageError('');
  }

  useEffect(() => {
    if (!serverRules) {
      return;
    }

    const nextServerDraft = chatRulesSchema.parse(serverRules);
    const shouldHydrate = shouldHydrateRulesDraftFromServer({
      currentDraft: rulesDraftRef.current,
      previousServerSnapshot: previousRulesServerSnapshotRef.current,
      nextServerDraft,
    });
    previousRulesServerSnapshotRef.current = serializeRulesDraftPayload(nextServerDraft);
    if (!shouldHydrate) {
      return;
    }

    setRulesDraft(nextServerDraft);
    setRulesTextError('');
    setRulesButtonErrors([]);
    setRulesButtonFieldsTouched(false);
    setRulesButtonRevealSignal(0);
  }, [serverRules, identity]);

  const rulesDraftSnapshot = useMemo(
    () => (rulesDraft ? serializeRulesDraftPayload(rulesDraft) : ''),
    [rulesDraft],
  );

  const rulesServerSnapshot = useMemo(
    () => (serverRules ? serializeRulesDraftPayload(serverRules) : ''),
    [serverRules],
  );

  const hasRulesChanges = Boolean(
    rulesDraft && serverRules && rulesDraftSnapshot !== rulesServerSnapshot,
  );
  const rulesPublication = rulesDraft ?? serverRules;
  const rulesPublishedMessageId = rulesPublication?.publishedMessageId ?? null;
  const rulesPublishedUrl = rulesPublication?.publishedUrl ?? null;
  const hasPublishedRules = Boolean(rulesPublishedMessageId || rulesPublishedUrl);
  const saveRulesMutation = useMutation({
    mutationFn: (request: { identity: typeof identity; payload: UpdateChatRulesPayload }) =>
      updateRules(api, request.identity.chatId ?? '', request.payload),
    onSuccess: (saved, { identity: requestScope, payload }) => {
      const payloadSnapshot = serializeRulesDraftPayload(payload);
      queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
        ['settings-screen', requestScope.chatId],
        (current) => mergeSavedRulesIntoSettingsScreen(current, saved),
      );
      if (active.current !== requestScope) {
        void queryClient.invalidateQueries({ queryKey: ['settings-screen', requestScope.chatId] });
        return;
      }
      setRulesDraft((current) => {
        if (!current) {
          return saved;
        }
        const currentSnapshot = serializeRulesDraftPayload(current);
        return currentSnapshot === payloadSnapshot ? saved : current;
      });
      setRulesTextError('');
      setRulesButtonErrors([]);
      setRulesButtonFieldsTouched(false);
      setRulesButtonRevealSignal(0);
      setRulesFailedSnapshot('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', requestScope.chatId] });
    },
    onError: (error, { identity: requestScope, payload }) => {
      if (active.current !== requestScope) return;
      setRulesFailedSnapshot(serializeRulesDraftPayload(payload));
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить черновик правил',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingRules = saveRulesMutation.isPending;
  const mutateRules = useCallback(
    (payload: UpdateChatRulesPayload) => {
      if (active.current === identity) saveRulesMutation.mutate({ identity, payload });
    },
    [identity, saveRulesMutation.mutate],
  );
  const mutateRulesAsync = (payload: UpdateChatRulesPayload) =>
    saveRulesMutation.mutateAsync({ identity, payload });

  const publishRulesMutation = useMutation({
    mutationFn: (request: {
      identity: typeof identity;
      mode: RulesPublicationMode;
      previousMessageId: string | null;
    }) => publishRules(api, request.identity.chatId ?? '', { mode: request.mode }),
    onSuccess: (result, request) => {
      void queryClient.invalidateQueries({
        queryKey: ['settings-screen', request.identity.chatId],
      });
      if (active.current !== request.identity) return;
      const updated = chatRulesSchema.parse({
        ...(rulesDraft ?? serverRules ?? {}),
        publishedMessageId: result.messageId,
        publishedUrl: result.url,
        publishedAt: result.publishedAt,
      });
      setRulesDraft(updated);
      pushToast({
        tone: 'success',
        ...getRulesPublicationFeedback(result, request.previousMessageId),
      });
      maxNotify('success');
    },
    onError: (error, request) => {
      if (active.current !== request.identity) return;
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать правила',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isPublishingRules = publishRulesMutation.isPending;

  const resetPublishedRulesMutation = useMutation({
    mutationFn: (requestScope: typeof identity) =>
      resetPublishedRules(api, requestScope.chatId ?? ''),
    onSuccess: (updated, requestScope) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', requestScope.chatId] });
      if (active.current !== requestScope) return;
      const nextDraft = chatRulesSchema.parse({
        ...(rulesDraft ?? updated),
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      setRulesDraft(nextDraft);
      pushToast({
        tone: 'success',
        title: 'Пост правил удалён',
      });
    },
    onError: (error, requestScope) => {
      if (active.current !== requestScope) return;
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить пост правил',
        description: formatApiError(error),
      });
    },
  });
  const isResettingPublishedRules = resetPublishedRulesMutation.isPending;

  const isRulesDraftEditingDisabled =
    isPreparingRulesPublish ||
    isPublishingRules ||
    isResettingPublishedRules ||
    isUpdatingRulesAttachment;
  const isRulesBusy = isSavingRules || isRulesDraftEditingDisabled || isPreparingRulesImage;
  function validateRulesDraft(
    value: ChatRules,
    options: { forceButtonErrors?: boolean } = {},
  ): UpdateChatRulesPayload | null {
    const normalizedText = value.text;
    if (normalizedText.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return null;
    }
    setRulesTextError('');

    if (value.imageBase64) {
      if (!value.imageMimeType.toLowerCase().startsWith('image/')) {
        setRulesImageError('Поддерживаются только изображения.');
        return null;
      }
    }

    const shouldShowButtonErrors = Boolean(options.forceButtonErrors || rulesButtonFieldsTouched);
    const normalizedButtonState = buildBroadcastLinkButtonLegacyFields(value.buttons);
    if (value.buttonEnabled) {
      const nextButtonErrors = validateBroadcastLinkButtons(value.buttons);
      if (hasBroadcastLinkButtonErrors(nextButtonErrors)) {
        setRulesButtonErrors(shouldShowButtonErrors ? nextButtonErrors : []);
        return null;
      }
      setRulesButtonErrors([]);
    } else {
      setRulesButtonErrors([]);
    }

    /* eslint-disable @typescript-eslint/no-unused-vars -- Rest excludes server-only metadata. */
    const {
      publishedMessageId: _publishedMessageId,
      publishedUrl: _publishedUrl,
      publishedAt: _publishedAt,
      ...editableDraft
    } = value;
    /* eslint-enable @typescript-eslint/no-unused-vars */
    return {
      ...editableDraft,
      buttonUrl: normalizedButtonState.buttonUrl,
      buttonText: normalizedButtonState.buttonText,
      adminContactButtonUrl: value.adminContactButtonEnabled ? value.adminContactButtonUrl : '',
    };
  }
  function reportRulesAutofillError(error: unknown) {
    const description = error instanceof Error ? error.message : 'Не удалось собрать текст правил.';
    setRulesTextError(description);
    pushToast({
      tone: 'danger',
      title: 'Не удалось собрать текст правил',
      description,
    });
    maxNotify('error');
  }
  function buildRulesDraftFromCurrentSettings(value: ChatRules): ChatRules {
    if (!currentRulesTextSource) {
      throw new Error('Настройки чата ещё загружаются.');
    }

    return {
      ...value,
      autoTextEnabled: true,
      text: buildRulesTextFromSettingsScreen(currentRulesTextSource),
      textFormat: 'plain',
    };
  }
  function prepareRulesDraftForSubmit(value: ChatRules): ChatRules | null {
    if (!value.autoTextEnabled) {
      return value;
    }

    try {
      const nextDraft = buildRulesDraftFromCurrentSettings(value);
      setRulesTextError('');
      if (serializeRulesDraftPayload(nextDraft) !== serializeRulesDraftPayload(value)) {
        const applyAutofill = (current: ChatRules | null) =>
          current
            ? {
                ...current,
                text: nextDraft.text,
                textFormat: nextDraft.textFormat,
                autoTextEnabled: true,
              }
            : current;
        // FLAG: Fast save receipts must compare against this prepared draft, not the previous render.
        rulesDraftRef.current = applyAutofill(rulesDraftRef.current ?? value);
        setRulesDraft(applyAutofill);
      }
      return nextDraft;
    } catch (error) {
      reportRulesAutofillError(error);
      return null;
    }
  }
  async function saveRulesDraftNow(
    options: { forceButtonErrors?: boolean; draft?: ChatRules } = {},
  ): Promise<ChatRules | null> {
    const targetDraft = options.draft ?? rulesDraft;
    if (!targetDraft || rulesImagePreparingRef.current) {
      return null;
    }

    const payload = validateRulesDraft(targetDraft, options);
    if (!payload) {
      return null;
    }

    return mutateRulesAsync(payload);
  }
  async function handleSaveRulesDraft() {
    if (!rulesDraft || !hasRulesChanges || isRulesBusy) {
      return;
    }

    const preparedRulesDraft = prepareRulesDraftForSubmit(rulesDraft);
    if (!preparedRulesDraft) {
      return;
    }

    try {
      const attempt = await runRulesSaveAttempt({
        submittedDraft: preparedRulesDraft,
        save: () =>
          saveRulesDraftNow({
            forceButtonErrors: true,
            draft: preparedRulesDraft,
          }),
        getCurrentDraft: () => rulesDraftRef.current,
      });
      if (!isCurrentRulesScope() || !attempt?.isCurrent) {
        return;
      }
      pushToast({ tone: 'success', title: 'Черновик правил сохранён' });
      maxNotify('success');
    } catch {
      // The mutation reports the actionable error and keeps the draft available for retry.
    }
  }
  async function handlePublishRules() {
    if (!chatId || !rulesDraft || isRulesBusy || rulesImagePreparingRef.current) {
      return;
    }

    const preparedRulesDraft = prepareRulesDraftForSubmit(rulesDraft);
    if (!preparedRulesDraft) {
      return;
    }

    if (!preparedRulesDraft.autoTextEnabled && !preparedRulesDraft.text.trim()) {
      setRulesTextError('Введите текст правил перед публикацией.');
      return;
    }
    setRulesTextError('');

    if (preparedRulesDraft.text.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return;
    }

    const nextRulesSnapshot = serializeRulesDraftPayload(preparedRulesDraft);
    const shouldSavePreparedRules = nextRulesSnapshot !== rulesServerSnapshot;

    if (
      !shouldSavePreparedRules &&
      !validateRulesDraft(preparedRulesDraft, { forceButtonErrors: true })
    ) {
      return;
    }

    setIsPreparingRulesPublish(true);
    try {
      if (shouldSavePreparedRules) {
        const attempt = await runRulesSaveAttempt({
          submittedDraft: preparedRulesDraft,
          save: () =>
            saveRulesDraftNow({
              forceButtonErrors: true,
              draft: preparedRulesDraft,
            }),
          getCurrentDraft: () => rulesDraftRef.current,
        });
        if (!isCurrentRulesScope() || !attempt) {
          return;
        }
        if (!attempt.isCurrent) {
          pushToast({
            tone: 'info',
            title: 'Правила изменились',
            description: 'Сохраните актуальную версию и повторите публикацию.',
          });
          maxNotify('warning');
          return;
        }
      }

      if (!isCurrentRulesScope()) return;
      publishRulesMutation.mutate({
        identity,
        mode: hasPublishedRules ? rulesPublicationMode : 'new_message',
        previousMessageId: rulesPublishedMessageId,
      });
    } catch {
      // The save mutation reports the actionable error and preserves the latest draft.
    } finally {
      if (isCurrentRulesScope()) setIsPreparingRulesPublish(false);
    }
  }
  function handleResetPublishedRules() {
    if (!chatId || !hasPublishedRules || isResettingPublishedRules) {
      return;
    }

    setRulesResetConfirmationOpen(true);
  }
  function confirmResetPublishedRules() {
    setRulesResetConfirmationOpen(false);
    resetPublishedRulesMutation.mutate(identity);
  }
  function handleRulesButtonsEnabledChange(enabled: boolean) {
    setRulesButtonFieldsTouched(true);
    setRulesButtonErrors([]);
    if (enabled && (rulesDraft?.buttons.length ?? 0) === 0) {
      setRulesButtonRevealSignal((value) => value + 1);
    }
    setRulesDraft((current) => {
      if (!current) {
        return current;
      }

      if (!enabled) {
        return {
          ...current,
          buttons: [],
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: DEFAULT_RULES_POST_BUTTON_TEXT,
        };
      }

      const buttons =
        current.buttons.length > 0 ? current.buttons : [createEmptyBroadcastLinkButton()];
      const buttonState = buildBroadcastLinkButtonLegacyFields(buttons);

      return {
        ...current,
        buttons,
        buttonEnabled: true,
        buttonUrl: buttonState.buttonUrl,
        buttonText: buttonState.buttonText,
      };
    });
  }
  function handleRulesAdminContactButtonChange(enabled: boolean, url: string) {
    setRulesDraft((current) =>
      current
        ? {
            ...current,
            adminContactButtonEnabled: enabled,
            adminContactButtonUrl: enabled ? url : '',
          }
        : current,
    );
  }
  useEffect(() => {
    if (!rulesFailedSnapshot || rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    setRulesFailedSnapshot('');
  }, [rulesDraftSnapshot, rulesFailedSnapshot]);

  useEffect(() => {
    if (
      !chatId ||
      !rulesDraft ||
      !hasRulesChanges ||
      isSavingRules ||
      isPreparingRulesImage ||
      isPreparingRulesPublish ||
      isPublishingRules
    ) {
      return;
    }

    if (rulesFailedSnapshot && rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    const parsed = validateRulesDraft(rulesDraft);
    if (!parsed) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!rulesImagePreparingRef.current) mutateRules(parsed);
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    chatId,
    hasRulesChanges,
    isPreparingRulesImage,
    isPreparingRulesPublish,
    isPublishingRules,
    isSavingRules,
    mutateRules,
    rulesButtonFieldsTouched,
    rulesDraft,
    rulesDraftSnapshot,
    rulesFailedSnapshot,
  ]);

  return {
    rulesDraft,
    setRulesDraft,
    rulesPublicationMode,
    setRulesPublicationMode,
    rulesTextError,
    setRulesTextError,
    rulesImageError,
    setRulesImageError: (value: SetStateAction<string>) => {
      if (isCurrentRulesScope()) setRulesImageError(value);
    },
    isPreparingRulesImage,
    handleRulesImagePreparationChange,
    rulesButtonErrors,
    setRulesButtonErrors,
    setRulesButtonFieldsTouched,
    rulesButtonsSheetOpen,
    setRulesButtonsSheetOpen,
    rulesButtonRevealSignal,
    isPreparingRulesPublish,
    rulesResetConfirmationOpen,
    setRulesResetConfirmationOpen,
    reportRulesAutofillError,
    buildRulesDraftFromCurrentSettings,
    saveRulesDraftNow,
    handleSaveRulesDraft,
    handlePublishRules,
    handleResetPublishedRules,
    confirmResetPublishedRules,
    handleRulesButtonsEnabledChange,
    handleRulesAdminContactButtonChange,
    hasRulesChanges,
    rulesPublishedUrl,
    hasPublishedRules,
    isSavingRules,
    isPublishingRules,
    isResettingPublishedRules,
    isRulesDraftEditingDisabled,
    isRulesBusy,
  };
}
