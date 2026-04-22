import {
  MAX_CHANNEL_DIALOG_ATTACHMENTS,
  MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64,
  MAX_CHANNEL_DIALOG_COMMENT_FILES,
} from '@maxim/contracts';
import { Attachment as IconoirAttachment, Camera as IconoirCamera } from 'iconoir-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { describeApiError } from '../lib/api-error';
import {
  getDialogBrowserHandoffSession,
  submitDialogBrowserHandoffMessage,
} from '../lib/api/dialog-browser-handoff-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import {
  formatDialogAttachmentSize,
  prepareCommentDialogFileAttachment,
  prepareCommentDialogImageAttachment,
  type PreparedCommentDialogAttachment,
} from '../lib/dialog-attachments';
import { openMaxBotLink } from '../lib/max-bridge';

type AttachmentKind = 'image' | 'file';

function calculateDraftAttachmentsBase64Length(
  attachments: PreparedCommentDialogAttachment[],
): number {
  return attachments.reduce((total, attachment) => total + attachment.base64.length, 0);
}

function AttachmentFallbackGlyph({ kind }: { kind: AttachmentKind }) {
  return (
    <span className="browser-dialog-compose__attachment-glyph" aria-hidden>
      {kind === 'image' ? 'IMG' : 'FILE'}
    </span>
  );
}

function normalizeApiError(error: unknown): string {
  return describeApiError(error, 'Не удалось связаться с сервером.');
}

export function BrowserDialogComposePage({ api }: { api: ApiTransport }) {
  const [searchParams] = useSearchParams();
  const handoffId = searchParams.get('handoff')?.trim() ?? '';
  const { pushToast } = useToast();
  const [draft, setDraft] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<PreparedCommentDialogAttachment[]>([]);
  const [isPreparingAttachment, setIsPreparingAttachment] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ returnUrl: string | null } | null>(null);
  const initializedHandoffIdRef = useRef<string | null>(null);

  const handoffQuery = useQuery({
    queryKey: ['dialog-browser-handoff', handoffId],
    queryFn: () => getDialogBrowserHandoffSession(api, handoffId),
    enabled: Boolean(handoffId) && !submitResult,
    retry: false,
  });

  useEffect(() => {
    if (!handoffQuery.data || initializedHandoffIdRef.current === handoffQuery.data.handoffId) {
      return;
    }

    initializedHandoffIdRef.current = handoffQuery.data.handoffId;
    setDraft(handoffQuery.data.draftText);
    setDraftAttachments([]);
  }, [handoffQuery.data]);

  useEffect(() => {
    if (!submitResult?.returnUrl) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      openMaxBotLink(submitResult.returnUrl!);
    }, 220);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [submitResult]);

  const appendDraftAttachments = (nextAttachments: PreparedCommentDialogAttachment[]) => {
    if (nextAttachments.length === 0) {
      return;
    }

    setDraftAttachments((current) => {
      const merged = [...current, ...nextAttachments];
      if (merged.length > MAX_CHANNEL_DIALOG_ATTACHMENTS) {
        pushToast({
          tone: 'danger',
          title: 'Слишком много вложений',
          description: `Можно добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений.`,
        });
        return current;
      }

      const fileCount = merged.filter((attachment) => attachment.type === 'file').length;
      if (fileCount > MAX_CHANNEL_DIALOG_COMMENT_FILES) {
        pushToast({
          tone: 'danger',
          title: 'Слишком много файлов',
          description: `Можно прикрепить до ${MAX_CHANNEL_DIALOG_COMMENT_FILES} файлов.`,
        });
        return current;
      }

      const totalBase64Length = calculateDraftAttachmentsBase64Length(merged);
      if (totalBase64Length > MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64) {
        pushToast({
          tone: 'danger',
          title: 'Вложения слишком тяжёлые',
          description: 'Уберите часть файлов или фото и попробуйте снова.',
        });
        return current;
      }

      return merged;
    });
  };

  const prepareAttachmentsFromFiles = async (kind: AttachmentKind, files: File[]) => {
    if (files.length === 0) {
      return;
    }

    setIsPreparingAttachment(true);
    try {
      const prepared: PreparedCommentDialogAttachment[] = [];
      let firstError: string | null = null;

      for (const file of files) {
        try {
          prepared.push(
            kind === 'image'
              ? await prepareCommentDialogImageAttachment(file)
              : await prepareCommentDialogFileAttachment(file),
          );
        } catch (error: unknown) {
          if (!firstError && error instanceof Error && error.message.trim()) {
            firstError = error.message;
          } else if (!firstError) {
            firstError =
              kind === 'image' ? 'Не удалось подготовить фото.' : 'Не удалось подготовить файл.';
          }
        }
      }

      appendDraftAttachments(prepared);

      if (firstError) {
        pushToast({
          tone: 'danger',
          title: kind === 'image' ? 'Фото не добавлено' : 'Файл не добавлен',
          description: firstError,
        });
      }
    } finally {
      setIsPreparingAttachment(false);
    }
  };

  const handleAttachmentInput = async (
    kind: AttachmentKind,
    event: ReactChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    await prepareAttachmentsFromFiles(kind, files);
  };

  const submitMutation = useMutation({
    mutationFn: () =>
      submitDialogBrowserHandoffMessage(api, handoffId, {
        text: draft,
        attachments: draftAttachments.map((attachment) => ({
          type: attachment.type,
          base64: attachment.base64,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          ...(attachment.width ? { width: attachment.width } : {}),
          ...(attachment.height ? { height: attachment.height } : {}),
        })),
      }),
    onSuccess: (result) => {
      setSubmitResult({ returnUrl: result.returnUrl });
      setDraft('');
      setDraftAttachments([]);
      pushToast({
        tone: 'success',
        title: 'Комментарий отправлен',
        description: 'Можно вернуться в MAX.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отправить комментарий',
        description: normalizeApiError(error),
      });
    },
  });

  const canSubmit =
    !submitMutation.isPending &&
    !isPreparingAttachment &&
    (draft.trim().length > 0 || draftAttachments.length > 0);

  if (!handoffId) {
    return (
      <div className="page-stack page-enter browser-dialog-compose">
        <GlassCard className="browser-dialog-compose__card" elevated>
          <StatusState
            tone="warning"
            title="Ссылка на загрузку неполная"
            description="Откройте браузерную загрузку снова из мини-приложения MAX."
          />
        </GlassCard>
      </div>
    );
  }

  if (submitResult) {
    return (
      <div className="page-stack page-enter browser-dialog-compose">
        <GlassCard className="browser-dialog-compose__card" elevated>
          <StatusState
            tone="success"
            title={submitResult.returnUrl ? 'Возвращаем в MAX' : 'Комментарий отправлен'}
            description={
              submitResult.returnUrl
                ? 'Комментарий уже отправлен. Если MAX не откроется сам, вернитесь вручную.'
                : 'Комментарий уже отправлен.'
            }
            action={
              submitResult.returnUrl ? (
                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => openMaxBotLink(submitResult.returnUrl!)}
                >
                  Вернуться в MAX
                </button>
              ) : null
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (handoffQuery.isLoading) {
    return (
      <div className="page-stack page-enter browser-dialog-compose">
        <GlassCard className="browser-dialog-compose__card" elevated>
          <StatusState
            tone="neutral"
            title="Подготавливаю загрузку"
            description="Забираю контекст комментария и готовлю браузерную форму отправки."
          />
        </GlassCard>
      </div>
    );
  }

  if (!handoffQuery.data) {
    return (
      <div className="page-stack page-enter browser-dialog-compose">
        <GlassCard className="browser-dialog-compose__card" elevated>
          <StatusState
            tone="warning"
            title="Ссылка на загрузку устарела"
            description={normalizeApiError(handoffQuery.error)}
            action={
              handoffQuery.error ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => handoffQuery.refetch()}
                >
                  Попробовать снова
                </button>
              ) : null
            }
          />
        </GlassCard>
      </div>
    );
  }

  const handoff = handoffQuery.data;

  return (
    <div className="page-stack page-enter browser-dialog-compose">
      <GlassCard className="browser-dialog-compose__card" elevated>
        <div className="browser-dialog-compose__eyebrow">Продолжение комментария</div>
        <h1 className="browser-dialog-compose__title">{handoff.title}</h1>
        <p className="browser-dialog-compose__lead">
          Текст комментария уже перенесён. Выберите фото или файл и отправьте сообщение, затем
          страница вернёт вас обратно в MAX.
        </p>

        {handoff.replyTo ? (
          <div className="channel-dialog-compose__reply browser-dialog-compose__reply">
            <div className="channel-dialog-compose__reply-copy">
              <span>Ответ на комментарий</span>
              <p>{handoff.replyTo.text}</p>
            </div>
          </div>
        ) : null}

        {draftAttachments.length > 0 ? (
          <div className="browser-dialog-compose__attachments">
            {draftAttachments.map((attachment, attachmentIndex) => (
              <div
                key={`${attachment.fileName}-${attachmentIndex}`}
                className="channel-dialog-compose__attachment"
              >
                <div className="channel-dialog-compose__attachment-preview" aria-hidden>
                  {attachment.type === 'image' && attachment.previewUrl ? (
                    <img src={attachment.previewUrl} alt="" loading="lazy" />
                  ) : (
                    <AttachmentFallbackGlyph kind={attachment.type} />
                  )}
                </div>
                <div className="channel-dialog-compose__attachment-copy">
                  <strong>{attachment.type === 'image' ? 'Фото' : 'Файл'}</strong>
                  <span>
                    {[attachment.fileName, formatDialogAttachmentSize(attachment.size)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <button
                  type="button"
                  className="channel-dialog-compose__attachment-dismiss"
                  onClick={() =>
                    setDraftAttachments((current) =>
                      current.filter((_, currentIndex) => currentIndex !== attachmentIndex),
                    )
                  }
                  aria-label={`Убрать ${attachment.fileName || 'вложение'}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <label className="channel-dialog-compose__field browser-dialog-compose__field">
          <textarea
            rows={5}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Комментарий"
            maxLength={2_000}
          />
        </label>

        <div className="browser-dialog-compose__toolbar">
          <label
            className={cn(
              'button button--ghost browser-dialog-compose__picker',
              (submitMutation.isPending || isPreparingAttachment) &&
                'browser-dialog-compose__picker--disabled',
            )}
          >
            <IconoirCamera aria-hidden />
            <span>Фото</span>
            <input
              className="channel-dialog-compose__picker-input"
              type="file"
              accept="image/*"
              multiple
              disabled={submitMutation.isPending || isPreparingAttachment}
              onChange={(event) => void handleAttachmentInput('image', event)}
            />
          </label>
          <label
            className={cn(
              'button button--ghost browser-dialog-compose__picker',
              (submitMutation.isPending || isPreparingAttachment) &&
                'browser-dialog-compose__picker--disabled',
            )}
          >
            <IconoirAttachment aria-hidden />
            <span>Файл</span>
            <input
              className="channel-dialog-compose__picker-input"
              type="file"
              multiple
              disabled={submitMutation.isPending || isPreparingAttachment}
              onChange={(event) => void handleAttachmentInput('file', event)}
            />
          </label>
        </div>

        <div className="browser-dialog-compose__footer">
          <span className="browser-dialog-compose__counter">
            {draft.trim().length}/2000 · {draftAttachments.length} влож.
          </span>
          <button
            type="button"
            className="button button--accent"
            disabled={!canSubmit}
            onClick={() => submitMutation.mutate()}
          >
            {submitMutation.isPending ? 'Отправка...' : 'Отправить комментарий'}
          </button>
        </div>
      </GlassCard>
    </div>
  );
}
