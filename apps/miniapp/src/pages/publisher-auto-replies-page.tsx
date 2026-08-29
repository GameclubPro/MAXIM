import type { BroadcastImage } from '@maxim/contracts';
import {
  type PublisherAutoReplyAsset,
  type PublisherAutoReplyRule,
} from '@maxim/contracts/publisher-auto-replies';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EditPencil,
  Key,
  NavArrowLeft,
  Plus,
  Refresh,
  Trash,
  WarningCircle,
  Xmark,
} from 'iconoir-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AutoReplyCreateSheet } from '../components/auto-reply-create-sheet';
import { BroadcastContentComposer } from '../components/broadcast-content-composer';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { Spinner } from '../components/ui/spinner';
import { useToast } from '../components/ui/toast';
import {
  archivePublisherAutoReply,
  cancelCurrentPublisherAutoReplyAuthoringSession,
  createPublisherAutoReply,
  createPublisherAutoReplyAuthoringSession,
  createPublisherAutoReplyRequestId,
  getCurrentPublisherAutoReplyAuthoringSession,
  getPublisherAutoReplyAsset,
  listPublisherAutoReplies,
  updatePublisherAutoReply,
} from '../lib/api/publisher-auto-replies-client';
import { getPublisherEntity, updatePublisherModules } from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { clearAutoReplyDraft } from '../lib/auto-reply-draft';
import { useManagedEntityLeaveGuard } from '../lib/managed-entity-navigation';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { useAutoReplyDraft } from '../lib/use-auto-reply-draft';
import { describeUserFacingError } from '../lib/user-facing-error';
import {
  AUTO_REPLY_COOLDOWN_OPTIONS,
  AUTO_REPLY_MAX_IMAGES,
  AUTO_REPLY_PHRASE_MAX_LENGTH,
  AUTO_REPLY_TEXT_MAX_LENGTH,
  buildPublisherChatModulesRoute,
  createEmptyAutoReplyDraft,
  getAutoReplyCooldownLabel,
  getAutoReplyAuthoringStateLabel,
  isActiveAutoReplyAuthoringState,
  isAutoReplyConflictError,
  normalizeAutoReplyDraft,
  validateAutoReplyDraft,
  type AutoReplyDraft,
  type AutoReplyDraftIssues,
} from './publisher-auto-replies-page-model';
import './publisher-auto-replies-page.css';

const AUTO_REPLY_QUERY_ROOT = ['publisher-auto-replies'] as const;
const PUBLISHER_ENTITY_QUERY_ROOT = ['publisher-entity'] as const;

type EditorTarget = { kind: 'create' } | { kind: 'edit'; rule: PublisherAutoReplyRule };

function AutoReplySwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="auto-reply-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="auto-reply-switch__track" aria-hidden>
        <span className="auto-reply-switch__thumb" />
      </span>
    </label>
  );
}

function AutoReplyAssetThumbnail({
  api,
  chatId,
  ruleId,
  asset,
}: {
  api: ApiTransport;
  chatId: string;
  ruleId: string;
  asset: PublisherAutoReplyAsset;
}) {
  const [reload, setReload] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setFailed(false);
    void getPublisherAutoReplyAsset(api, chatId, ruleId, asset.id, {
      signal: controller.signal,
    }).then(
      (blob) => {
        if (controller.signal.aborted) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      },
      () => {
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      },
    );
    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [api, asset.id, chatId, reload, ruleId]);

  if (failed) {
    return (
      <button
        type="button"
        className="publisher-auto-reply-asset is-error"
        onClick={() => setReload((value) => value + 1)}
        aria-label={`Повторить загрузку фото ${asset.fileName || asset.id}`}
      >
        <Refresh aria-hidden />
      </button>
    );
  }

  return (
    <span className="publisher-auto-reply-asset" aria-busy={!previewUrl || undefined}>
      {previewUrl ? <img src={previewUrl} alt="" /> : <Spinner size="sm" label={null} />}
    </span>
  );
}

function RetainedAssetEditorItem({
  api,
  chatId,
  ruleId,
  asset,
  disabled,
  onRemove,
}: {
  api: ApiTransport;
  chatId: string;
  ruleId: string;
  asset: PublisherAutoReplyAsset;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <figure className="publisher-auto-reply-editor__retained-item">
      <AutoReplyAssetThumbnail api={api} chatId={chatId} ruleId={ruleId} asset={asset} />
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Убрать фото ${asset.fileName || asset.id}`}
        title="Убрать фото"
      >
        <Xmark aria-hidden />
      </button>
    </figure>
  );
}

function createDraftFromRule(rule: PublisherAutoReplyRule): AutoReplyDraft {
  return {
    phrase: rule.phrase,
    text: rule.content.text,
    images: [],
    retainedAssets: rule.content.images.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
    })),
    cooldownSeconds: rule.cooldownSeconds,
    enabled: rule.enabled,
  };
}

function buildRuleFromList(
  current: readonly PublisherAutoReplyRule[],
  updated: PublisherAutoReplyRule,
): PublisherAutoReplyRule[] {
  const next = current.map((rule) => (rule.id === updated.id ? updated : rule));
  return next.some((rule) => rule.id === updated.id) ? next : [updated, ...next];
}

function PublisherAutoReplyEditor({
  api,
  chatId,
  target,
  onClose,
  onSaved,
}: {
  api: ApiTransport;
  chatId: string;
  target: EditorTarget;
  onClose: () => void;
  onSaved: (rule: PublisherAutoReplyRule) => void;
}) {
  const { pushToast } = useToast();
  const rule = target.kind === 'edit' ? target.rule : null;
  const initialDraft = useMemo(
    () => (rule ? createDraftFromRule(rule) : createEmptyAutoReplyDraft()),
    [rule],
  );
  const { draft, setDraft, hydrated, dirty, persist, discard, markSaved } = useAutoReplyDraft({
    chatId,
    ruleId: rule?.id,
    initialDraft,
  });
  const [issues, setIssues] = useState<AutoReplyDraftIssues>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [imagesPreparing, setImagesPreparing] = useState(false);
  const requestIdRef = useRef<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (value: AutoReplyDraft) => {
      const normalized = normalizeAutoReplyDraft(value);
      requestIdRef.current ??= createPublisherAutoReplyRequestId();
      const content = {
        text: normalized.text,
        textFormat: 'markdown' as const,
        images: [
          ...normalized.retainedAssets.map((asset) => ({
            type: 'image-ref' as const,
            assetId: asset.id,
          })),
          ...normalized.images.map((image) => ({
            type: 'image' as const,
            base64: image.base64,
            mimeType: image.mimeType,
            fileName: image.fileName,
          })),
        ],
      };

      return rule
        ? updatePublisherAutoReply(api, chatId, rule.id, {
            requestId: requestIdRef.current,
            expectedVersion: rule.version,
            phrase: normalized.phrase,
            enabled: normalized.enabled,
            cooldownSeconds: normalized.cooldownSeconds,
            content,
          })
        : createPublisherAutoReply(api, chatId, {
            requestId: requestIdRef.current,
            phrase: normalized.phrase,
            enabled: normalized.enabled,
            cooldownSeconds: normalized.cooldownSeconds,
            content,
          });
    },
    onSuccess: async (savedRule) => {
      requestIdRef.current = null;
      setConflict(false);
      setReviewOpen(false);
      await markSaved(createDraftFromRule(savedRule));
      pushToast({
        tone: 'success',
        title: rule ? 'Автоответ обновлён' : 'Автоответ создан',
      });
      onSaved(savedRule);
    },
    onError: (error) => {
      setReviewOpen(false);
      if (isAutoReplyConflictError(error)) {
        setConflict(true);
        pushToast({
          tone: 'danger',
          title: 'Правило уже изменилось',
          description: 'Закройте редактор и откройте свежую версию.',
        });
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить автоответ.'),
      });
    },
  });

  const updateDraft = useCallback(
    (change: Partial<AutoReplyDraft>) => {
      setConflict(false);
      setDraft((current) => ({ ...current, ...change }));
    },
    [setDraft],
  );

  const validateAndReview = useCallback(() => {
    const nextIssues = validateAutoReplyDraft(draft);
    setIssues(nextIssues);
    if (Object.keys(nextIssues).length === 0) {
      setReviewOpen(true);
    }
  }, [draft]);

  const requestClose = useCallback(() => {
    if (saveMutation.isPending) {
      return;
    }
    if (dirty) {
      setCloseConfirmOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose, saveMutation.isPending]);

  useNativeBackHandler(
    () => {
      requestClose();
      return true;
    },
    { enabled: !reviewOpen && !closeConfirmOpen, priority: 500 },
  );

  useManagedEntityLeaveGuard({
    dirty,
    saving: saveMutation.isPending,
    save: async () => {
      const nextIssues = validateAutoReplyDraft(draft);
      setIssues(nextIssues);
      if (Object.keys(nextIssues).length > 0) {
        pushToast({ tone: 'danger', title: 'Проверьте поля автоответа' });
        return false;
      }
      try {
        await saveMutation.mutateAsync(draft);
        return true;
      } catch {
        return false;
      }
    },
    discard: () => {
      void discard();
    },
  });

  const totalImages = draft.retainedAssets.length + draft.images.length;
  const retainedById = new Map(rule?.content.images.map((asset) => [asset.id, asset]) ?? []);

  if (!hydrated) {
    return (
      <div className="publisher-auto-replies-page__state" role="status">
        <Spinner label={null} />
        <strong>Восстанавливаю редактор</strong>
      </div>
    );
  }

  return (
    <div className="publisher-auto-reply-editor" aria-busy={saveMutation.isPending || undefined}>
      <header className="publisher-auto-reply-editor__header">
        <button type="button" onClick={requestClose} aria-label="Закрыть редактор" title="Назад">
          <NavArrowLeft aria-hidden />
        </button>
        <span>
          <strong>{rule ? 'Изменить автоответ' : 'Новый автоответ'}</strong>
        </span>
      </header>

      {conflict ? (
        <div className="publisher-auto-reply-editor__conflict" role="alert">
          <WarningCircle aria-hidden />
          <span>Эта версия устарела. Закройте редактор и откройте правило снова.</span>
        </div>
      ) : null}

      <section className="publisher-auto-reply-editor__section">
        <header>
          <h2 id="publisher-auto-reply-phrase-title">Кодовая фраза</h2>
          <small>Точное совпадение</small>
        </header>
        <div className={cn('publisher-auto-reply-editor__field', issues.phrase && 'has-error')}>
          <input
            value={draft.phrase}
            maxLength={AUTO_REPLY_PHRASE_MAX_LENGTH}
            disabled={saveMutation.isPending}
            placeholder="Например: прайс"
            autoCapitalize="sentences"
            aria-labelledby="publisher-auto-reply-phrase-title"
            aria-describedby="publisher-auto-reply-phrase-meta"
            aria-invalid={Boolean(issues.phrase)}
            onChange={(event) => {
              updateDraft({ phrase: event.target.value });
              if (issues.phrase) {
                setIssues((current) => ({ ...current, phrase: undefined }));
              }
            }}
          />
          <small
            id="publisher-auto-reply-phrase-meta"
            className="publisher-auto-reply-editor__field-meta"
            role={issues.phrase ? 'alert' : undefined}
          >
            {issues.phrase ?? `${draft.phrase.length}/${AUTO_REPLY_PHRASE_MAX_LENGTH}`}
          </small>
        </div>
      </section>

      <section className="publisher-auto-reply-editor__section is-content">
        <header>
          <h2>Ответ</h2>
        </header>

        {rule && draft.retainedAssets.length > 0 ? (
          <div
            className="publisher-auto-reply-editor__retained"
            aria-label="Сохранённые фотографии"
          >
            {draft.retainedAssets.map((metadata) => {
              const asset = retainedById.get(metadata.id);
              return asset ? (
                <RetainedAssetEditorItem
                  key={asset.id}
                  api={api}
                  chatId={chatId}
                  ruleId={rule.id}
                  asset={asset}
                  disabled={saveMutation.isPending}
                  onRemove={() =>
                    updateDraft({
                      retainedAssets: draft.retainedAssets.filter((item) => item.id !== asset.id),
                    })
                  }
                />
              ) : null;
            })}
          </div>
        ) : null}

        <BroadcastContentComposer
          className="publisher-auto-reply-editor__composer"
          text={draft.text}
          sourceFormat="markdown"
          maxLength={AUTO_REPLY_TEXT_MAX_LENGTH}
          images={draft.images}
          maxImages={Math.max(1, AUTO_REPLY_MAX_IMAGES - draft.retainedAssets.length)}
          allowImages={draft.retainedAssets.length < AUTO_REPLY_MAX_IMAGES}
          disabled={saveMutation.isPending}
          textError={issues.content}
          messageAriaLabel="Ответ на кодовую фразу"
          textPlaceholder="Текст ответа"
          textAriaLabel="Текст автоответа"
          showToolLabels
          onTextChange={(text) => {
            updateDraft({ text });
            if (issues.content) {
              setIssues((current) => ({ ...current, content: undefined }));
            }
          }}
          onImagesChange={(images: BroadcastImage[]) => {
            updateDraft({ images });
            if (issues.content) {
              setIssues((current) => ({ ...current, content: undefined }));
            }
          }}
          onImagePreparationChange={setImagesPreparing}
          onError={(message) => pushToast({ tone: 'danger', title: message })}
        />
        {totalImages > 0 ? (
          <small className="publisher-auto-reply-editor__image-count">
            {totalImages} из {AUTO_REPLY_MAX_IMAGES} фото
          </small>
        ) : null}
      </section>

      <section className="publisher-auto-reply-editor__section">
        <header>
          <h2>Настройки</h2>
        </header>
        <div className="publisher-auto-reply-editor__toggle-row">
          <strong>Правило включено</strong>
          <AutoReplySwitch
            checked={draft.enabled}
            disabled={saveMutation.isPending}
            label={draft.enabled ? 'Выключить правило' : 'Включить правило'}
            onChange={(enabled) => updateDraft({ enabled })}
          />
        </div>
        <label className="publisher-auto-reply-editor__select-field">
          <span>Пауза для одного участника</span>
          <select
            value={draft.cooldownSeconds}
            disabled={saveMutation.isPending}
            onChange={(event) => updateDraft({ cooldownSeconds: Number(event.target.value) })}
          >
            {AUTO_REPLY_COOLDOWN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <footer className="publisher-auto-reply-editor__save-bar">
        <button
          type="button"
          disabled={saveMutation.isPending || imagesPreparing || conflict}
          onClick={validateAndReview}
        >
          {saveMutation.isPending ? 'Сохраняю...' : 'Продолжить'}
        </button>
      </footer>

      <ActionConfirmSheet
        id="publisher-auto-reply-review"
        open={reviewOpen}
        title={rule ? 'Сохранить изменения?' : 'Создать автоответ?'}
        summary={`Фраза «${normalizeAutoReplyDraft(draft).phrase}» сработает только при точном совпадении.`}
        previewTitle={
          <MaxMarkdownPreview
            value={draft.text}
            sourceFormat="markdown"
            fallback={totalImages > 0 ? 'Ответ без текста' : null}
          />
        }
        previewMeta={`${
          totalImages > 0 ? `${totalImages} фото · ` : ''
        }Пауза: ${getAutoReplyCooldownLabel(draft.cooldownSeconds)} · ${
          draft.enabled ? 'включён' : 'выключен'
        }`}
        confirmLabel={rule ? 'Сохранить' : 'Создать'}
        confirmBusyLabel="Сохраняю..."
        tone="accent"
        isBusy={saveMutation.isPending}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => saveMutation.mutate(draft)}
      />

      <ActionConfirmSheet
        id="publisher-auto-reply-close"
        open={closeConfirmOpen}
        title="Закрыть редактор?"
        summary="Черновик останется на этом устройстве и восстановится при следующем открытии."
        confirmLabel="Закрыть"
        tone="danger"
        onClose={() => setCloseConfirmOpen(false)}
        onConfirm={() => {
          persist();
          setCloseConfirmOpen(false);
          onClose();
        }}
      />
    </div>
  );
}

function AutoReplyRuleRow({
  api,
  chatId,
  rule,
  busy,
  conflict,
  onToggle,
  onEdit,
  onDelete,
}: {
  api: ApiTransport;
  chatId: string;
  rule: PublisherAutoReplyRule;
  busy: boolean;
  conflict: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className={cn('publisher-auto-reply-row', !rule.enabled && 'is-disabled')}>
      <div className="publisher-auto-reply-row__head">
        <span className="publisher-auto-reply-row__phrase">
          <Key aria-hidden />
          <strong>{rule.phrase}</strong>
        </span>
        <AutoReplySwitch
          checked={rule.enabled}
          disabled={busy}
          label={`${rule.enabled ? 'Выключить' : 'Включить'} автоответ «${rule.phrase}»`}
          onChange={onToggle}
        />
      </div>

      <div className="publisher-auto-reply-row__content">
        {rule.content.images.length > 0 ? (
          <div className="publisher-auto-reply-row__assets" aria-label="Фотографии ответа">
            {rule.content.images.slice(0, 3).map((asset) => (
              <AutoReplyAssetThumbnail
                key={asset.id}
                api={api}
                chatId={chatId}
                ruleId={rule.id}
                asset={asset}
              />
            ))}
            {rule.content.images.length > 3 ? (
              <span className="publisher-auto-reply-row__asset-more">
                +{rule.content.images.length - 3}
              </span>
            ) : null}
          </div>
        ) : null}
        <MaxMarkdownPreview
          value={rule.content.text}
          sourceFormat={rule.content.textFormat}
          className="publisher-auto-reply-row__preview"
          fallback={rule.content.images.length > 0 ? 'Ответ без текста' : 'Пустой ответ'}
        />
      </div>

      <footer className="publisher-auto-reply-row__footer">
        <span>
          {rule.content.images.length > 0 ? `${rule.content.images.length} фото · ` : ''}
          Пауза: {getAutoReplyCooldownLabel(rule.cooldownSeconds)}
        </span>
        <span className="publisher-auto-reply-row__actions">
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            aria-label={`Редактировать автоответ «${rule.phrase}»`}
            title="Редактировать"
          >
            <EditPencil aria-hidden />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Удалить автоответ «${rule.phrase}»`}
            title="Удалить"
          >
            <Trash aria-hidden />
          </button>
        </span>
      </footer>
      {conflict ? (
        <div className="publisher-auto-reply-row__conflict" role="alert">
          <WarningCircle aria-hidden />
          <span>Правило изменилось. Загружена свежая версия.</span>
        </div>
      ) : null}
    </article>
  );
}

export function PublisherAutoRepliesPage({ api }: { api: ApiTransport }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { entityId = '' } = useParams<{ entityId: string }>();
  const chatId = entityId.trim();
  const queryKey = [...AUTO_REPLY_QUERY_ROOT, chatId] as const;
  const authoringQueryKey = [...AUTO_REPLY_QUERY_ROOT, chatId, 'authoring'] as const;
  const entityQueryKey = [...PUBLISHER_ENTITY_QUERY_ROOT, 'chat', chatId] as const;
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublisherAutoReplyRule | null>(null);
  const [conflictRuleId, setConflictRuleId] = useState<string | null>(null);
  const [botBusy, setBotBusy] = useState(false);
  const completedAuthoringSessionRef = useRef<string | null>(null);
  const authoringRequestIdRef = useRef<string | null>(null);

  const entityQuery = useQuery({
    queryKey: entityQueryKey,
    queryFn: ({ signal }) => getPublisherEntity(api, 'chat', chatId, { signal }),
    enabled: chatId.length > 0,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const rulesQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => listPublisherAutoReplies(api, chatId, { signal }),
    enabled: chatId.length > 0,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const authoringQuery = useQuery({
    queryKey: authoringQueryKey,
    queryFn: ({ signal }) => getCurrentPublisherAutoReplyAuthoringSession(api, chatId, { signal }),
    enabled: chatId.length > 0,
    staleTime: 2_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      isActiveAutoReplyAuthoringState(query.state.data?.session?.state) ? 2_500 : false,
  });
  const moduleMutation = useMutation({
    mutationFn: (autoRepliesEnabled: boolean) => {
      const entity = entityQuery.data;
      if (!entity) {
        throw new Error('Чат ещё не загружен.');
      }
      return updatePublisherModules(api, 'chat', chatId, {
        expectedRevision: entity.moduleSettings.revision,
        autoRepliesEnabled,
      });
    },
    onSuccess: (moduleSettings) => {
      queryClient.setQueryData(entityQueryKey, (current: unknown) =>
        current && typeof current === 'object' ? { ...current, moduleSettings } : current,
      );
    },
    onError: async (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось изменить модуль.'),
      });
      await queryClient.invalidateQueries({ queryKey: entityQueryKey });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ rule, enabled }: { rule: PublisherAutoReplyRule; enabled: boolean }) =>
      updatePublisherAutoReply(api, chatId, rule.id, {
        requestId: createPublisherAutoReplyRequestId(),
        expectedVersion: rule.version,
        enabled,
      }),
    onMutate: ({ rule, enabled }) => {
      setConflictRuleId(null);
      queryClient.setQueryData(queryKey, (current: unknown) => {
        if (!current || typeof current !== 'object' || !('items' in current)) {
          return current;
        }
        const response = current as { items: PublisherAutoReplyRule[]; total: number };
        return {
          ...response,
          items: response.items.map((item) => (item.id === rule.id ? { ...item, enabled } : item)),
        };
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, (current: unknown) => {
        if (!current || typeof current !== 'object' || !('items' in current)) {
          return current;
        }
        const response = current as { items: PublisherAutoReplyRule[]; total: number };
        return { ...response, items: buildRuleFromList(response.items, updated) };
      });
    },
    onError: async (error, variables) => {
      if (isAutoReplyConflictError(error)) {
        setConflictRuleId(variables.rule.id);
      } else {
        pushToast({
          tone: 'danger',
          title: describeUserFacingError(error, 'Не удалось изменить правило.'),
        });
      }
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (rule: PublisherAutoReplyRule) =>
      archivePublisherAutoReply(api, chatId, rule.id, {
        requestId: createPublisherAutoReplyRequestId(),
        expectedVersion: rule.version,
      }),
    onSuccess: async (_response, rule) => {
      await clearAutoReplyDraft(chatId, rule.id);
      setDeleteTarget(null);
      pushToast({ tone: 'success', title: 'Автоответ удалён' });
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: async (error, rule) => {
      if (isAutoReplyConflictError(error)) {
        setConflictRuleId(rule.id);
        setDeleteTarget(null);
      } else {
        pushToast({
          tone: 'danger',
          title: describeUserFacingError(error, 'Не удалось удалить автоответ.'),
        });
      }
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const cancelAuthoringMutation = useMutation({
    mutationFn: () => cancelCurrentPublisherAutoReplyAuthoringSession(api, chatId),
    onSuccess: (response) => {
      queryClient.setQueryData(authoringQueryKey, response);
      pushToast({ tone: 'info', title: 'Создание через Публика отменено' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось отменить создание.'),
      });
    },
  });

  const handleSaved = (savedRule: PublisherAutoReplyRule) => {
    queryClient.setQueryData(queryKey, (current: unknown) => {
      if (!current || typeof current !== 'object' || !('items' in current)) {
        return { items: [savedRule], total: 1 };
      }
      const response = current as { items: PublisherAutoReplyRule[]; total: number };
      const exists = response.items.some((rule) => rule.id === savedRule.id);
      return {
        ...response,
        items: buildRuleFromList(response.items, savedRule),
        total: exists ? response.total : response.total + 1,
      };
    });
    setEditorTarget(null);
    void queryClient.invalidateQueries({ queryKey });
  };

  const handleOpenBot = async () => {
    setBotBusy(true);
    try {
      authoringRequestIdRef.current ??= createPublisherAutoReplyRequestId();
      const response = await createPublisherAutoReplyAuthoringSession(api, chatId, {
        requestId: authoringRequestIdRef.current,
      });
      authoringRequestIdRef.current = null;
      queryClient.setQueryData(authoringQueryKey, {
        session: response.session,
        botUrl: response.botUrl,
      });
      const botUrl = response.botUrl;
      if (!botUrl || !openMaxBotLinkAndClose(botUrl)) {
        throw new Error('Не удалось открыть диалог с Публиком.');
      }
      setCreateSheetOpen(false);
      setBotBusy(false);
    } catch (error) {
      if (isAutoReplyConflictError(error)) {
        const current = await authoringQuery.refetch();
        const botUrl = current.data?.botUrl;
        if (botUrl && openMaxBotLinkAndClose(botUrl)) {
          setCreateSheetOpen(false);
          setBotBusy(false);
          return;
        }
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось открыть Публика.'),
      });
      setBotBusy(false);
    }
  };

  useEffect(() => {
    const session = authoringQuery.data?.session;
    if (session?.state !== 'completed' || completedAuthoringSessionRef.current === session.id) {
      return;
    }
    completedAuthoringSessionRef.current = session.id;
    void queryClient.invalidateQueries({ queryKey });
  }, [authoringQuery.data?.session, chatId, queryClient]);

  useEffect(() => {
    document.body.classList.add('publisher-auto-replies-open');
    return () => document.body.classList.remove('publisher-auto-replies-open');
  }, []);

  if (!chatId) {
    return (
      <section className="publisher-auto-replies-page">
        <div className="publisher-auto-replies-page__state has-error" role="alert">
          <WarningCircle aria-hidden />
          <strong>Чат не найден</strong>
          <Link to="/">Вернуться</Link>
        </div>
      </section>
    );
  }

  if (editorTarget) {
    return (
      <section className="publisher-auto-replies-page is-editor">
        <PublisherAutoReplyEditor
          key={editorTarget.kind === 'edit' ? editorTarget.rule.id : 'new'}
          api={api}
          chatId={chatId}
          target={editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={handleSaved}
        />
      </section>
    );
  }

  const entity = entityQuery.data;
  const rules = rulesQuery.data?.items ?? [];
  const loading = entityQuery.isLoading || rulesQuery.isLoading;
  const refreshing = entityQuery.isFetching || rulesQuery.isFetching;
  const rowBusyId = toggleMutation.variables?.rule.id ?? deleteMutation.variables?.id ?? null;

  return (
    <section className="publisher-auto-replies-page" aria-busy={refreshing || undefined}>
      <header className="publisher-auto-replies-page__header">
        <button
          type="button"
          onClick={() => navigate(buildPublisherChatModulesRoute(chatId))}
          aria-label="Вернуться к модулям"
          title="Назад"
        >
          <NavArrowLeft aria-hidden />
        </button>
        <EntityAvatar
          title={entity?.title ?? 'Чат'}
          entityType="chat"
          avatarUrl={entity?.avatarUrl ?? null}
          className="publisher-auto-replies-page__avatar"
        />
        <span className="publisher-auto-replies-page__identity">
          <strong>Автоответы</strong>
          <small>{entity?.title.trim() || 'Чат'}</small>
        </span>
        <button
          type="button"
          className={cn(refreshing && 'is-refreshing')}
          disabled={refreshing}
          onClick={() => void Promise.all([rulesQuery.refetch(), entityQuery.refetch()])}
          aria-label="Обновить автоответы"
          title="Обновить"
        >
          <Refresh aria-hidden />
        </button>
      </header>

      {authoringQuery.data?.session &&
      isActiveAutoReplyAuthoringState(authoringQuery.data.session.state) ? (
        <div className="publisher-auto-replies-page__authoring">
          <span>
            <strong>Черновик в Публике</strong>
            <small aria-live="polite">
              {getAutoReplyAuthoringStateLabel(authoringQuery.data.session.state)}
            </small>
          </span>
          <span className="publisher-auto-replies-page__authoring-actions">
            {authoringQuery.data.botUrl ? (
              <button
                type="button"
                onClick={() => openMaxBotLinkAndClose(authoringQuery.data!.botUrl!)}
              >
                Продолжить
              </button>
            ) : null}
            <button
              type="button"
              disabled={cancelAuthoringMutation.isPending}
              onClick={() => cancelAuthoringMutation.mutate()}
              aria-label="Отменить создание через Публика"
              title="Отменить"
            >
              <Xmark aria-hidden />
            </button>
          </span>
        </div>
      ) : null}

      {entity ? (
        <div className="publisher-auto-replies-page__module-toggle">
          <span>
            <strong>Автоответы в чате</strong>
            <small>
              {entity.moduleSettings.autoRepliesEnabled === true ? 'Включены' : 'Выключены'}
            </small>
          </span>
          <AutoReplySwitch
            checked={entity.moduleSettings.autoRepliesEnabled === true}
            disabled={moduleMutation.isPending}
            label={
              entity.moduleSettings.autoRepliesEnabled
                ? 'Выключить модуль автоответов'
                : 'Включить модуль автоответов'
            }
            onChange={(enabled) => moduleMutation.mutate(enabled)}
          />
        </div>
      ) : null}

      {loading ? (
        <div className="publisher-auto-replies-page__state" role="status">
          <Spinner label={null} />
          <strong>Загружаю автоответы</strong>
        </div>
      ) : rulesQuery.isError || entityQuery.isError ? (
        <div className="publisher-auto-replies-page__state has-error" role="alert">
          <WarningCircle aria-hidden />
          <strong>Не удалось загрузить автоответы</strong>
          <button
            type="button"
            onClick={() => void Promise.all([rulesQuery.refetch(), entityQuery.refetch()])}
          >
            <Refresh aria-hidden />
            <span>Повторить</span>
          </button>
        </div>
      ) : rules.length === 0 ? (
        <div className="publisher-auto-replies-page__empty">
          <span aria-hidden>
            <Key />
          </span>
          <strong>Нет автоответов</strong>
          <button type="button" onClick={() => setCreateSheetOpen(true)}>
            <Plus aria-hidden />
            <span>Добавить автоответ</span>
          </button>
        </div>
      ) : (
        <div className="publisher-auto-replies-page__list">
          {rules.map((rule) => (
            <AutoReplyRuleRow
              key={rule.id}
              api={api}
              chatId={chatId}
              rule={rule}
              busy={rowBusyId === rule.id}
              conflict={conflictRuleId === rule.id}
              onToggle={(enabled) => toggleMutation.mutate({ rule, enabled })}
              onEdit={() => setEditorTarget({ kind: 'edit', rule })}
              onDelete={() => setDeleteTarget(rule)}
            />
          ))}
        </div>
      )}

      {!loading && !rulesQuery.isError && !entityQuery.isError && rules.length > 0 ? (
        <button
          type="button"
          className="publisher-auto-replies-page__add"
          onClick={() => setCreateSheetOpen(true)}
          aria-label="Добавить автоответ"
          title="Добавить автоответ"
        >
          <Plus aria-hidden />
        </button>
      ) : null}

      <AutoReplyCreateSheet
        open={createSheetOpen}
        busy={botBusy}
        onClose={() => setCreateSheetOpen(false)}
        onWrite={() => {
          setCreateSheetOpen(false);
          setEditorTarget({ kind: 'create' });
        }}
        onOpenBot={() => void handleOpenBot()}
      />

      <ActionConfirmSheet
        id="publisher-auto-reply-delete"
        open={deleteTarget !== null}
        title="Удалить автоответ?"
        summary="Публик перестанет отвечать на эту кодовую фразу."
        previewTitle={deleteTarget?.phrase}
        confirmLabel="Удалить"
        confirmBusyLabel="Удаляю..."
        tone="danger"
        isBusy={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMutation.mutate(deleteTarget);
          }
        }}
      />
    </section>
  );
}
