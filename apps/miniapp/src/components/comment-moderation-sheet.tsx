import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavArrowLeft, NavArrowRight, Xmark, ShieldCheck } from 'iconoir-react';
import type { UpdateCommentRestrictionRequest } from '@maxim/contracts/channel-dialog';
import {
  commentModerationKey,
  getCommentRestriction,
  getCommentRestrictions,
  updateCommentRestriction,
  type CommentModerationContext,
} from '../lib/api/comment-moderation-client';
import { commentRestrictionLabel } from '../lib/comment-restriction';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import { useNativeBackHandler } from '../lib/native-back';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import { describeUserFacingError } from '../lib/user-facing-error';
import { useToast } from './ui/toast';
import './comment-moderation-sheet.css';

export type CommentModerationTarget = {
  userId: string;
  displayName: string | null;
  sourceMessageId?: string;
};
type Props = {
  context: CommentModerationContext;
  target: CommentModerationTarget | null;
  onClose: () => void;
};

const normalizeApiError = (error: unknown) =>
  describeUserFacingError(error, 'Не удалось загрузить ограничения');

export default function CommentModerationSheet({ context, target: initialTarget, onClose }: Props) {
  const [target, setTarget] = useState(initialTarget);
  const [action, setAction] = useState<UpdateCommentRestrictionRequest['action']>('MUTE');
  const [duration, setDuration] = useState<3600 | 86400 | 604800>(86400);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const key = commentModerationKey(context);
  const viewportStyle = useVisualViewportOverlayStyle(true);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && panel.current?.contains(active)) {
        active.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [viewportStyle?.height]);
  const list = useInfiniteQuery({
    queryKey: [...key, 'restrictions'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => getCommentRestrictions(context, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !target,
    retry: false,
  });
  const current = useQuery({
    queryKey: [...key, 'user', target?.userId],
    queryFn: ({ signal }) => getCommentRestriction(context, target!.userId, signal),
    enabled: Boolean(target),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () =>
      updateCommentRestriction(context, target!.userId, {
        action,
        ...(action === 'MUTE' ? { durationSeconds: duration } : {}),
        reason,
        expectedRevision: confirmedRevision!,
        // Existing restrictions remain manageable after the source comment is deleted.
        ...(confirmedRevision === 0 && target!.sourceMessageId
          ? { sourceMessageId: target!.sourceMessageId }
          : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      pushToast({
        tone: 'success',
        title:
          action === 'RELEASE'
            ? 'Ограничение снято'
            : action === 'BAN'
              ? 'Автор заблокирован в комментариях'
              : 'Мут применён',
      });
      onClose();
    },
    onError: async () => {
      setConfirm(false);
      await current.refetch();
    },
  });
  const back = () => {
    if (mutation.isPending) return;
    if (confirm) setConfirm(false);
    else if (target && !initialTarget) {
      setTarget(null);
      mutation.reset();
    } else onClose();
  };
  useDialogFocusTrap(true, panel, closeButton);
  useEffect(() => {
    if (confirm) panel.current?.focus({ preventScroll: true });
  }, [confirm]);
  useNativeBackHandler(
    () => {
      back();
      return true;
    },
    { priority: 800 },
  );
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        back();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  });
  const name =
    target?.displayName || current.data?.displayName || (target ? `Участник ${target.userId}` : '');
  const actionLabel =
    action === 'RELEASE' ? 'Снять ограничение' : action === 'BAN' ? 'Забанить' : 'Применить мут';
  const scopeLabel = `Все комментарии ${context.entityType === 'channel' ? 'канала' : 'чата'} в ${context.profile === 'publisher' ? 'Публике' : 'Майоре'}`;

  return createPortal(
    <div className="comment-moderation-sheet" style={viewportStyle}>
      <button
        className="comment-moderation-sheet__backdrop"
        aria-label="Закрыть ограничения"
        tabIndex={-1}
        onClick={back}
        disabled={mutation.isPending}
      />
      <section
        className="comment-moderation-sheet__panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="comment-moderation-title"
        tabIndex={-1}
      >
        <header>
          <h2 id="comment-moderation-title">
            {confirm ? 'Подтверждение' : target ? 'Ограничения автора' : 'Ограничения'}
          </h2>
          <button
            ref={closeButton}
            className="comment-moderation-sheet__icon"
            aria-label={confirm || (target && !initialTarget) ? 'Назад' : 'Закрыть'}
            title="Закрыть"
            onClick={back}
            disabled={mutation.isPending}
          >
            {confirm || (target && !initialTarget) ? <NavArrowLeft /> : <Xmark />}
          </button>
        </header>
        <div className="comment-moderation-sheet__content">
          <p className="comment-moderation-sheet__scope">{scopeLabel}</p>
          {target ? (
            <>
              <strong className="comment-moderation-sheet__name">{name}</strong>
              <small>ID {target.userId}</small>
              {current.isPending ? <p role="status">Загрузка ограничения...</p> : null}
              {current.error ? (
                <div role="alert">
                  <p>{normalizeApiError(current.error)}</p>
                  <button onClick={() => void current.refetch()}>Повторить</button>
                </div>
              ) : null}
              {current.data ? (
                <>
                  <p className="comment-moderation-sheet__status">
                    {commentRestrictionLabel(current.data)}
                  </p>
                  {current.data.reason ? <p>{current.data.reason}</p> : null}
                  {confirm ? (
                    <div className="comment-moderation-sheet__confirmation">
                      <strong>
                        {actionLabel}
                        {action === 'MUTE'
                          ? ` на ${duration === 3600 ? '1 час' : duration === 86400 ? '1 день' : '7 дней'}`
                          : action === 'BAN'
                            ? ' без срока'
                            : ''}
                        ?
                      </strong>
                      <p>
                        {action === 'RELEASE'
                          ? 'Участие в комментариях снова будет доступно.'
                          : 'Отправка, редактирование и реакции будут недоступны. Чтение и членство в MAX сохранятся.'}
                      </p>
                      {reason && action !== 'RELEASE' ? <p>Причина: {reason}</p> : null}
                    </div>
                  ) : (
                    <>
                      <fieldset disabled={mutation.isPending}>
                        <legend>Действие</legend>
                        {(['MUTE', 'BAN', ...(current.data.kind ? ['RELEASE'] : [])] as const).map(
                          (value) => (
                            <label key={value}>
                              <input
                                type="radio"
                                name="comment-sanction"
                                value={value}
                                checked={action === value}
                                onChange={() => {
                                  setAction(value as typeof action);
                                  mutation.reset();
                                }}
                              />
                              {value === 'MUTE'
                                ? 'Мут'
                                : value === 'BAN'
                                  ? 'Бан без срока'
                                  : 'Снять ограничение'}
                            </label>
                          ),
                        )}
                      </fieldset>
                      {action === 'MUTE' ? (
                        <label className="comment-moderation-sheet__field">
                          Срок
                          <select
                            aria-label="Срок мута"
                            value={duration}
                            onChange={(event) =>
                              setDuration(Number(event.target.value) as typeof duration)
                            }
                          >
                            <option value={3600}>1 час</option>
                            <option value={86400}>1 день</option>
                            <option value={604800}>7 дней</option>
                          </select>
                        </label>
                      ) : null}
                      {action !== 'RELEASE' ? (
                        <label className="comment-moderation-sheet__field">
                          Причина для участника <span>(необязательно)</span>
                          <textarea
                            rows={2}
                            maxLength={300}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                          />
                        </label>
                      ) : null}
                    </>
                  )}
                </>
              ) : null}
              {mutation.error ? <p role="alert">{normalizeApiError(mutation.error)}</p> : null}
            </>
          ) : (
            <>
              {list.isPending ? <p role="status">Загрузка ограничений...</p> : null}
              {list.error ? (
                <div role="alert">
                  <p>{normalizeApiError(list.error)}</p>
                  <button onClick={() => void list.refetch()}>Повторить</button>
                </div>
              ) : null}
              {list.data?.pages
                .flatMap((page) => page.items)
                .map((item) => (
                  <button
                    className="comment-moderation-sheet__participant"
                    key={item.userId}
                    onClick={() => {
                      setTarget(item);
                      setAction('RELEASE');
                      setReason('');
                      setConfirm(false);
                    }}
                  >
                    <ShieldCheck aria-hidden />
                    <span>
                      <strong>{item.displayName || `Участник ${item.userId}`}</strong>
                      <small>{commentRestrictionLabel(item)}</small>
                    </span>
                    <NavArrowRight aria-hidden />
                  </button>
                ))}
              {list.data?.pages[0]?.items.length === 0 ? <p>Активных ограничений нет.</p> : null}
              {list.hasNextPage ? (
                <button
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  Показать ещё
                </button>
              ) : null}
            </>
          )}
        </div>
        {target && current.data ? (
          <footer>
            <button onClick={back} disabled={mutation.isPending}>
              Отмена
            </button>
            <button
              className={action === 'RELEASE' ? 'is-release' : 'is-danger'}
              disabled={
                mutation.isPending ||
                current.isFetching ||
                (action === 'RELEASE' && !current.data.kind)
              }
              onClick={() => {
                if (confirm) mutation.mutate();
                else {
                  setConfirmedRevision(current.data!.revision);
                  setConfirm(true);
                }
              }}
            >
              {mutation.isPending ? 'Сохраняем...' : confirm ? actionLabel : 'Продолжить'}
            </button>
          </footer>
        ) : null}
      </section>
    </div>,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
