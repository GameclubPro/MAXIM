import {
  MANAGED_POLL_MAX_OPTIONS,
  MANAGED_POLL_MIN_OPTIONS,
  MANAGED_POLL_OPTION_MAX_LENGTH,
  MANAGED_POLL_QUESTION_MAX_LENGTH,
  type CreateManagedPollRequest,
  type ManagedPollDetails,
  type ManagedPollListResponse,
  type ManagedPollSummary,
  type ManagedPollVoter,
  type ManagedPollVisibility,
} from '@maxim/contracts/poll';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  CheckCircle,
  EditPencil,
  Eye,
  NavArrowLeft,
  OpenNewWindow,
  Plus,
  RefreshCircle,
  SendDiagonal,
  Trash,
  User,
} from 'iconoir-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { describeApiError } from '../lib/api-error';
import {
  closeChannelManagedPoll,
  createChannelManagedPoll,
  deleteChannelManagedPoll,
  getChannelManagedPollVoters,
  getChannelManagedPolls,
  publishChannelManagedPoll,
  refreshChannelManagedPollPublication,
  resetChannelManagedPollPublication,
  updateChannelManagedPoll,
} from '../lib/api/channel-polls-client';
import type { ApiTransport } from '../lib/api/transport';
import { channelPollQueryKeys } from '../lib/channel-poll-query-keys';
import { openMaxBotLink } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { ActionConfirmSheet } from './ui/action-confirm-sheet';
import { SegmentedControl } from './ui/segmented-control';
import { SkeletonCard } from './ui/skeleton';
import { StatusState } from './ui/status-state';
import { useToast } from './ui/toast';
import './managed-poll-workspace.css';

type PollWorkspaceTab = 'current' | 'archive';

type PollDraftOption = {
  key: string;
  id?: string;
  text: string;
};

type PollEditorDraft = {
  pollId: string | null;
  question: string;
  visibility: ManagedPollVisibility;
  options: PollDraftOption[];
};

type PollValidationErrors = {
  question: string;
  options: Record<string, string>;
};

type PollConfirmState =
  | { kind: 'discard'; closePanel?: boolean }
  | { kind: 'publish'; draft: PollEditorDraft }
  | { kind: 'close'; poll: ManagedPollSummary }
  | { kind: 'reset-publication'; poll: ManagedPollSummary }
  | { kind: 'delete'; poll: ManagedPollSummary };

export type ManagedPollWorkspaceHandle = {
  requestClose: () => void;
};

type ManagedPollWorkspaceProps = {
  api: ApiTransport;
  channelId: string;
  onClosePanel: () => void;
};

let nextPollOptionKey = 1;

function createOptionKey(): string {
  const key = `poll-option-${nextPollOptionKey}`;
  nextPollOptionKey += 1;
  return key;
}

function createEmptyDraft(): PollEditorDraft {
  return {
    pollId: null,
    question: '',
    visibility: 'ANONYMOUS',
    options: Array.from({ length: MANAGED_POLL_MIN_OPTIONS }, () => ({
      key: createOptionKey(),
      text: '',
    })),
  };
}

function toEditorDraft(poll: ManagedPollSummary): PollEditorDraft {
  return {
    pollId: poll.id,
    question: poll.question,
    visibility: poll.visibility,
    options: [...poll.options]
      .sort((left, right) => left.position - right.position)
      .map((option) => ({
        key: createOptionKey(),
        id: option.id,
        text: option.text,
      })),
  };
}

function buildPollPayload(draft: PollEditorDraft): CreateManagedPollRequest {
  return {
    question: draft.question.trim(),
    visibility: draft.visibility,
    options: draft.options.map((option) => ({
      ...(option.id ? { id: option.id } : {}),
      text: option.text.trim(),
    })),
  };
}

function buildDraftKey(draft: PollEditorDraft | null): string {
  return draft ? JSON.stringify(buildPollPayload(draft)) : '';
}

function normalizeOptionText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
}

function validateDraft(draft: PollEditorDraft): PollValidationErrors {
  const errors: PollValidationErrors = { question: '', options: {} };
  const question = draft.question.trim();
  if (!question) {
    errors.question = 'Введите вопрос.';
  } else if (question.length > MANAGED_POLL_QUESTION_MAX_LENGTH) {
    errors.question = `Максимум ${MANAGED_POLL_QUESTION_MAX_LENGTH} символов.`;
  }

  const seenOptions = new Map<string, string>();
  for (const option of draft.options) {
    const text = option.text.trim();
    if (!text) {
      errors.options[option.key] = 'Заполните вариант.';
      continue;
    }
    if (text.length > MANAGED_POLL_OPTION_MAX_LENGTH) {
      errors.options[option.key] = `Максимум ${MANAGED_POLL_OPTION_MAX_LENGTH} символов.`;
      continue;
    }

    const normalized = normalizeOptionText(text);
    const duplicateKey = seenOptions.get(normalized);
    if (duplicateKey) {
      errors.options[duplicateKey] = 'Варианты повторяются.';
      errors.options[option.key] = 'Варианты повторяются.';
      continue;
    }
    seenOptions.set(normalized, option.key);
  }

  return errors;
}

function hasValidationErrors(errors: PollValidationErrors): boolean {
  return Boolean(errors.question || Object.keys(errors.options).length > 0);
}

function sortPolls(items: ManagedPollSummary[]): ManagedPollSummary[] {
  const statusRank: Record<ManagedPollSummary['status'], number> = {
    ACTIVE: 0,
    DRAFT: 1,
    CLOSED: 2,
  };

  return [...items].sort((left, right) => {
    const rankDelta = statusRank[left.status] - statusRank[right.status];
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

function upsertPoll(
  current: InfiniteData<ManagedPollListResponse, string | null> | undefined,
  poll: ManagedPollDetails,
): InfiniteData<ManagedPollListResponse, string | null> {
  const pages = current?.pages ?? [{ items: [], nextCursor: null }];
  let found = false;
  const nextPages = pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.id !== poll.id) {
        return item;
      }
      found = true;
      return poll;
    }),
  }));
  if (!found) {
    nextPages[0] = {
      ...(nextPages[0] ?? { nextCursor: null }),
      items: [poll, ...(nextPages[0]?.items ?? [])],
    };
  }
  return {
    pages: nextPages,
    pageParams: current?.pageParams ?? [null],
  };
}

function formatVotes(value: number): string {
  const absolute = Math.abs(value);
  const lastTwo = absolute % 100;
  const last = absolute % 10;
  if (lastTwo >= 11 && lastTwo <= 14) {
    return `${value} голосов`;
  }
  if (last === 1) {
    return `${value} голос`;
  }
  if (last >= 2 && last <= 4) {
    return `${value} голоса`;
  }
  return `${value} голосов`;
}

function formatPollDate(value: string | null): string {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function resolveVoterName(voter: {
  displayName: string | null;
  username: string | null;
  userId: string | null;
}): string {
  const displayName = voter.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const username = voter.username?.trim().replace(/^@/u, '');
  if (username) {
    return `@${username}`;
  }
  return voter.userId ? `ID ${voter.userId}` : 'Участник';
}

function PollVoterDetails({
  api,
  channelId,
  poll,
}: {
  api: ApiTransport;
  channelId: string;
  poll: ManagedPollSummary;
}) {
  const votersQuery = useInfiniteQuery({
    queryKey: channelPollQueryKeys.voters(channelId, poll.id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      getChannelManagedPollVoters(api, channelId, poll.id, {
        cursor: pageParam,
        limit: 50,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: poll.visibility === 'OPEN',
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const voters = useMemo(() => {
    const unique = new Map<string, ManagedPollVoter>();
    for (const page of votersQuery.data?.pages ?? []) {
      for (const voter of page.items) {
        unique.set(voter.id, voter);
      }
    }
    return Array.from(unique.values());
  }, [votersQuery.data?.pages]);
  const hasVoterData = Boolean(votersQuery.data);
  const votersInitialError = votersQuery.error && !hasVoterData;
  const votersRefreshError = votersQuery.error && hasVoterData;

  return (
    <div className="managed-poll-voters" aria-live="polite">
      {votersQuery.isLoading ? (
        <span className="managed-poll-voters__state">Загрузка...</span>
      ) : null}
      {votersInitialError ? (
        <div className="managed-poll-voters__error">
          <span>{describeApiError(votersInitialError, 'Не удалось загрузить участников.')}</span>
          <button type="button" onClick={() => void votersQuery.refetch()}>
            Повторить
          </button>
        </div>
      ) : null}

      {votersRefreshError ? (
        <div className="managed-poll-voters__error">
          <span>Не удалось обновить</span>
          <button type="button" onClick={() => void votersQuery.refetch()}>
            Повторить
          </button>
        </div>
      ) : null}

      {!votersQuery.isLoading && hasVoterData
        ? [...poll.options]
            .sort((left, right) => left.position - right.position)
            .map((option) => {
              const optionVoters = voters.filter((voter) => voter.optionId === option.id);
              const remainingVoters = Math.max(0, option.votes - optionVoters.length);
              return (
                <section key={option.id} className="managed-poll-voters__group">
                  <div className="managed-poll-voters__group-head">
                    <strong>{option.text}</strong>
                    <span>{formatVotes(option.votes)}</span>
                  </div>
                  {optionVoters.length > 0 ? (
                    <div className="managed-poll-voters__names">
                      {optionVoters.map((voter) => (
                        <span key={voter.id} className="managed-poll-voters__name">
                          <User aria-hidden />
                          {resolveVoterName(voter)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <small>{remainingVoters > 0 ? 'Ещё не загружены' : 'Нет голосов'}</small>
                  )}
                  {optionVoters.length > 0 && remainingVoters > 0 ? (
                    <small>Ещё {remainingVoters}</small>
                  ) : null}
                </section>
              );
            })
        : null}

      {votersQuery.hasNextPage ? (
        <button
          type="button"
          className="managed-poll-voters__more"
          onClick={() => void votersQuery.fetchNextPage()}
          disabled={votersQuery.isFetchingNextPage}
        >
          {votersQuery.isFetchingNextPage ? 'Загрузка...' : 'Показать ещё'}
        </button>
      ) : null}
    </div>
  );
}

function PollResultCard({
  api,
  channelId,
  poll,
  votersOpen,
  busy,
  onEdit,
  onClose,
  onDelete,
  onRefreshPublication,
  onResetPublication,
  onToggleVoters,
}: {
  api: ApiTransport;
  channelId: string;
  poll: ManagedPollSummary;
  votersOpen: boolean;
  busy: boolean;
  onEdit: () => void;
  onClose: () => void;
  onDelete: () => void;
  onRefreshPublication: () => void;
  onResetPublication: () => void;
  onToggleVoters: () => void;
}) {
  const statusLabel = poll.publicationNeedsReview
    ? 'Нужна проверка'
    : poll.publicationPending
      ? 'Публикуется'
      : poll.status === 'ACTIVE'
        ? 'Идёт'
        : poll.status === 'CLOSED'
          ? 'Завершён'
          : 'Черновик';
  const date = formatPollDate(
    poll.status === 'CLOSED' ? poll.closedAt : (poll.publishedAt ?? poll.updatedAt),
  );
  const showResults = poll.status !== 'DRAFT';
  const canShowVoters = poll.visibility === 'OPEN' && poll.totalVotes > 0 && showResults;

  return (
    <article className="managed-poll-item">
      <header className="managed-poll-item__head">
        <div className="managed-poll-item__badges">
          <span
            className={`managed-poll-item__status is-${
              poll.publicationNeedsReview
                ? 'review'
                : poll.publicationPending
                  ? 'pending'
                  : poll.status.toLowerCase()
            }`}
          >
            {statusLabel}
          </span>
          <span className="managed-poll-item__visibility">
            {poll.visibility === 'ANONYMOUS' ? 'Анонимный' : 'Открытый'}
          </span>
        </div>
        <span className="managed-poll-item__date">{date}</span>
      </header>

      <h3>{poll.question}</h3>

      {showResults ? (
        <div className="managed-poll-results" aria-label="Результаты опроса">
          {[...poll.options]
            .sort((left, right) => left.position - right.position)
            .map((option) => (
              <div key={option.id} className="managed-poll-result">
                <div className="managed-poll-result__meta">
                  <span>{option.text}</span>
                  <strong>{option.percent}%</strong>
                </div>
                <div className="managed-poll-result__track" aria-hidden>
                  <span style={{ width: `${option.percent}%` }} />
                </div>
                <small>{formatVotes(option.votes)}</small>
              </div>
            ))}
        </div>
      ) : (
        <ol className="managed-poll-item__draft-options">
          {[...poll.options]
            .sort((left, right) => left.position - right.position)
            .map((option) => (
              <li key={option.id}>{option.text}</li>
            ))}
        </ol>
      )}

      <footer className="managed-poll-item__footer">
        <span className="managed-poll-item__votes">{formatVotes(poll.totalVotes)}</span>
        <div className="managed-poll-item__actions">
          {poll.publicationUrl ? (
            <button
              type="button"
              className="managed-poll-icon-button"
              aria-label="Открыть публикацию"
              title="Открыть публикацию"
              onClick={() => openMaxBotLink(poll.publicationUrl ?? '')}
            >
              <OpenNewWindow aria-hidden />
            </button>
          ) : null}
          {canShowVoters ? (
            <button
              type="button"
              className="managed-poll-action-button"
              aria-expanded={votersOpen}
              onClick={onToggleVoters}
            >
              <Eye aria-hidden />
              {votersOpen ? 'Скрыть' : 'Участники'}
            </button>
          ) : null}
          {poll.status === 'DRAFT' && !poll.publicationPending && !poll.publicationNeedsReview ? (
            <>
              <button
                type="button"
                className="managed-poll-action-button"
                onClick={onEdit}
                disabled={busy}
              >
                <EditPencil aria-hidden />
                Изменить
              </button>
              <button
                type="button"
                className="managed-poll-icon-button is-danger"
                aria-label="Удалить черновик"
                title="Удалить черновик"
                onClick={onDelete}
                disabled={busy}
              >
                <Trash aria-hidden />
              </button>
            </>
          ) : null}
          {poll.status === 'ACTIVE' ? (
            <button
              type="button"
              className="managed-poll-action-button"
              onClick={onClose}
              disabled={busy}
            >
              <CheckCircle aria-hidden />
              Закрыть
            </button>
          ) : null}
          {poll.renderRepairNeeded ? (
            <button
              type="button"
              className="managed-poll-action-button"
              onClick={onRefreshPublication}
              disabled={busy}
            >
              <RefreshCircle aria-hidden />
              Обновить пост
            </button>
          ) : null}
          {poll.publicationNeedsReview ? (
            <button
              type="button"
              className="managed-poll-action-button is-danger"
              onClick={onResetPublication}
              disabled={busy}
            >
              <RefreshCircle aria-hidden />
              Поста нет
            </button>
          ) : null}
        </div>
      </footer>

      {votersOpen ? <PollVoterDetails api={api} channelId={channelId} poll={poll} /> : null}
    </article>
  );
}

function PollEditor({
  draft,
  errors,
  busy,
  questionRef,
  optionRefs,
  onChange,
  onBack,
  onSave,
  onPublish,
}: {
  draft: PollEditorDraft;
  errors: PollValidationErrors;
  busy: boolean;
  questionRef: RefObject<HTMLTextAreaElement | null>;
  optionRefs: RefObject<Map<string, HTMLInputElement>>;
  onChange: (draft: PollEditorDraft) => void;
  onBack: () => void;
  onSave: () => void;
  onPublish: () => void;
}) {
  const setOptionText = (key: string, text: string) => {
    onChange({
      ...draft,
      options: draft.options.map((option) => (option.key === key ? { ...option, text } : option)),
    });
  };

  const addOption = () => {
    if (draft.options.length >= MANAGED_POLL_MAX_OPTIONS) {
      return;
    }
    const nextOption = { key: createOptionKey(), text: '' };
    onChange({ ...draft, options: [...draft.options, nextOption] });
    window.setTimeout(() => optionRefs.current?.get(nextOption.key)?.focus(), 0);
  };

  const removeOption = (key: string) => {
    if (draft.options.length <= MANAGED_POLL_MIN_OPTIONS) {
      return;
    }
    onChange({ ...draft, options: draft.options.filter((option) => option.key !== key) });
  };

  return (
    <section className="managed-poll-editor">
      <header className="managed-poll-editor__head">
        <button
          type="button"
          className="managed-poll-editor__back"
          onClick={onBack}
          disabled={busy}
        >
          <NavArrowLeft aria-hidden />К списку
        </button>
        <div>
          <h2>{draft.pollId ? 'Черновик' : 'Новый опрос'}</h2>
          <span>Один ответ</span>
        </div>
      </header>

      <div className="managed-poll-editor__section">
        <label className={errors.question ? 'is-error' : undefined}>
          <span className="managed-poll-editor__label-row">
            <strong>Вопрос</strong>
            <small>
              {draft.question.length}/{MANAGED_POLL_QUESTION_MAX_LENGTH}
            </small>
          </span>
          <textarea
            ref={questionRef}
            rows={3}
            value={draft.question}
            maxLength={MANAGED_POLL_QUESTION_MAX_LENGTH}
            placeholder="Ваш вопрос"
            aria-invalid={Boolean(errors.question)}
            aria-describedby={errors.question ? 'managed-poll-question-error' : undefined}
            onChange={(event) => onChange({ ...draft, question: event.target.value })}
            disabled={busy}
          />
          {errors.question ? (
            <small id="managed-poll-question-error" className="managed-poll-editor__error">
              {errors.question}
            </small>
          ) : null}
        </label>

        <label className="managed-poll-editor__privacy">
          <span>
            <strong>{draft.visibility === 'ANONYMOUS' ? 'Анонимный' : 'Открытый'}</strong>
            <small>{draft.visibility === 'ANONYMOUS' ? 'Имена скрыты' : 'Имена видны'}</small>
          </span>
          <span className="managed-poll-switch">
            <input
              type="checkbox"
              checked={draft.visibility === 'ANONYMOUS'}
              onChange={(event) =>
                onChange({
                  ...draft,
                  visibility: event.target.checked ? 'ANONYMOUS' : 'OPEN',
                })
              }
              disabled={busy}
              aria-label="Анонимный опрос"
            />
            <span aria-hidden />
          </span>
        </label>
      </div>

      <div className="managed-poll-editor__section managed-poll-editor__options">
        <div className="managed-poll-editor__section-head">
          <strong>Варианты</strong>
          <span>
            {draft.options.length}/{MANAGED_POLL_MAX_OPTIONS}
          </span>
        </div>

        <div className="managed-poll-editor__option-list">
          {draft.options.map((option, index) => {
            const optionError = errors.options[option.key];
            const errorId = `managed-poll-option-${option.key}-error`;
            return (
              <div
                key={option.key}
                className={`managed-poll-editor__option${optionError ? ' is-error' : ''}`}
              >
                <span className="managed-poll-editor__option-index">{index + 1}</span>
                <input
                  ref={(node) => {
                    if (node) {
                      optionRefs.current?.set(option.key, node);
                    } else {
                      optionRefs.current?.delete(option.key);
                    }
                  }}
                  type="text"
                  value={option.text}
                  maxLength={MANAGED_POLL_OPTION_MAX_LENGTH}
                  placeholder={`Вариант ${index + 1}`}
                  aria-label={`Вариант ответа ${index + 1}`}
                  aria-invalid={Boolean(optionError)}
                  aria-describedby={optionError ? errorId : undefined}
                  onChange={(event) => setOptionText(option.key, event.target.value)}
                  disabled={busy}
                />
                {draft.options.length > MANAGED_POLL_MIN_OPTIONS ? (
                  <button
                    type="button"
                    className="managed-poll-icon-button is-danger"
                    aria-label={`Удалить вариант ${index + 1}`}
                    title="Удалить вариант"
                    onClick={() => removeOption(option.key)}
                    disabled={busy}
                  >
                    <Trash aria-hidden />
                  </button>
                ) : null}
                {optionError ? (
                  <small id={errorId} className="managed-poll-editor__error">
                    {optionError}
                  </small>
                ) : null}
              </div>
            );
          })}
        </div>

        {draft.options.length < MANAGED_POLL_MAX_OPTIONS ? (
          <button
            type="button"
            className="managed-poll-editor__add"
            onClick={addOption}
            disabled={busy}
          >
            <Plus aria-hidden />
            Добавить вариант
          </button>
        ) : null}
      </div>

      <footer className="managed-poll-editor__actions">
        <button
          type="button"
          className="managed-poll-editor__save"
          onClick={onSave}
          disabled={busy}
        >
          {busy ? 'Сохраняем...' : 'Сохранить'}
        </button>
        <button
          type="button"
          className="managed-poll-editor__publish"
          onClick={onPublish}
          disabled={busy}
        >
          <SendDiagonal aria-hidden />
          Опубликовать
        </button>
      </footer>
    </section>
  );
}

export const ManagedPollWorkspace = forwardRef<
  ManagedPollWorkspaceHandle,
  ManagedPollWorkspaceProps
>(function ManagedPollWorkspace({ api, channelId, onClosePanel }, ref) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [tab, setTab] = useState<PollWorkspaceTab>('current');
  const [draft, setDraft] = useState<PollEditorDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<PollEditorDraft | null>(null);
  const [validationErrors, setValidationErrors] = useState<PollValidationErrors>({
    question: '',
    options: {},
  });
  const [confirmState, setConfirmState] = useState<PollConfirmState | null>(null);
  const [votersPollId, setVotersPollId] = useState<string | null>(null);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLInputElement>());
  const publishSavedPollRef = useRef<ManagedPollDetails | null>(null);
  const listQueryKey = channelPollQueryKeys.list(channelId);

  const pollsQuery = useInfiniteQuery({
    queryKey: listQueryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      getChannelManagedPolls(api, channelId, { cursor: pageParam, limit: 30, signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(channelId),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const hasPollData = Boolean(pollsQuery.data);
  const pollsInitialError = pollsQuery.error && !hasPollData;
  const pollsRefreshError = pollsQuery.error && hasPollData;

  const allPolls = useMemo(() => {
    const unique = new Map<string, ManagedPollSummary>();
    for (const page of pollsQuery.data?.pages ?? []) {
      for (const poll of page.items) {
        unique.set(poll.id, poll);
      }
    }
    return sortPolls(Array.from(unique.values()));
  }, [pollsQuery.data?.pages]);
  const currentPolls = useMemo(
    () => allPolls.filter((poll) => poll.status !== 'CLOSED'),
    [allPolls],
  );
  const archivedPolls = useMemo(
    () => allPolls.filter((poll) => poll.status === 'CLOSED'),
    [allPolls],
  );
  const visiblePolls = tab === 'current' ? currentPolls : archivedPolls;
  const isDirty = Boolean(draft && buildDraftKey(draft) !== buildDraftKey(savedDraft));

  const applyPoll = useCallback(
    (poll: ManagedPollDetails) => {
      queryClient.setQueryData<InfiniteData<ManagedPollListResponse, string | null>>(
        listQueryKey,
        (current) => upsertPoll(current, poll),
      );
      queryClient.setQueryData(channelPollQueryKeys.details(channelId, poll.id), poll);
    },
    [channelId, listQueryKey, queryClient],
  );

  const persistDraft = useCallback(
    (value: PollEditorDraft) => {
      const payload = buildPollPayload(value);
      return value.pollId
        ? updateChannelManagedPoll(api, channelId, value.pollId, payload)
        : createChannelManagedPoll(api, channelId, payload);
    },
    [api, channelId],
  );

  const saveMutation = useMutation({
    mutationFn: persistDraft,
    onSuccess: (saved) => {
      applyPoll(saved);
      const nextDraft = toEditorDraft(saved);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      pushToast({ tone: 'success', title: 'Черновик сохранён' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить',
        description: describeApiError(error, 'Повторите позже.'),
      });
    },
  });

  const publishMutation = useMutation({
    onMutate: () => {
      publishSavedPollRef.current = null;
    },
    mutationFn: async (value: PollEditorDraft) => {
      const saved = await persistDraft(value);
      publishSavedPollRef.current = saved;
      applyPoll(saved);
      return publishChannelManagedPoll(api, channelId, saved.id);
    },
    onSuccess: (published) => {
      publishSavedPollRef.current = null;
      applyPoll(published);
      setDraft(null);
      setSavedDraft(null);
      setConfirmState(null);
      setTab('current');
      pushToast({
        tone: published.publicationPending ? 'info' : 'success',
        title: published.publicationPending ? 'Публикация проверяется' : 'Опрос опубликован',
      });
    },
    onError: (error) => {
      if (publishSavedPollRef.current) {
        applyPoll(publishSavedPollRef.current);
        setDraft(null);
        setSavedDraft(null);
        void queryClient.invalidateQueries({ queryKey: listQueryKey });
      }
      publishSavedPollRef.current = null;
      setConfirmState(null);
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать',
        description: describeApiError(error, 'Повторите позже.'),
      });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (pollId: string) => closeChannelManagedPoll(api, channelId, pollId),
    onSuccess: (closed) => {
      applyPoll(closed);
      setConfirmState(null);
      setVotersPollId((current) => (current === closed.id ? null : current));
      if (closed.renderRepairNeeded) {
        setTab('archive');
      }
      pushToast(
        closed.renderRepairNeeded
          ? {
              tone: 'info',
              title: 'Опрос закрыт',
              description: 'Пост не обновился. Повторите.',
            }
          : { tone: 'success', title: 'Опрос закрыт' },
      );
    },
    onError: (error) => {
      setConfirmState(null);
      pushToast({
        tone: 'danger',
        title: 'Не удалось закрыть',
        description: describeApiError(error, 'Повторите позже.'),
      });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: (pollId: string) => refreshChannelManagedPollPublication(api, channelId, pollId),
    onSuccess: (refreshed) => {
      applyPoll(refreshed);
      pushToast(
        refreshed.renderRepairNeeded
          ? { tone: 'info', title: 'Пост пока не обновлён' }
          : { tone: 'success', title: 'Пост обновлён' },
      );
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить пост',
        description: describeApiError(error, 'Повторите позже.'),
      });
    },
  });

  const resetPublicationMutation = useMutation({
    mutationFn: (pollId: string) => resetChannelManagedPollPublication(api, channelId, pollId),
    onSuccess: (reset) => {
      applyPoll(reset);
      setConfirmState(null);
      pushToast({ tone: 'success', title: 'Публикация сброшена' });
    },
    onError: (error) => {
      setConfirmState(null);
      pushToast({
        tone: 'danger',
        title: 'Не удалось сбросить',
        description: describeApiError(error, 'Повторите позже.'),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (pollId: string) => deleteChannelManagedPoll(api, channelId, pollId),
    onSuccess: (_result, pollId) => {
      queryClient.setQueryData<InfiniteData<ManagedPollListResponse, string | null>>(
        listQueryKey,
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.filter((poll) => poll.id !== pollId),
                })),
              }
            : current,
      );
      queryClient.removeQueries({
        queryKey: channelPollQueryKeys.details(channelId, pollId),
      });
      if (draft?.pollId === pollId) {
        setDraft(null);
        setSavedDraft(null);
      }
      setConfirmState(null);
      pushToast({ tone: 'success', title: 'Черновик удалён' });
    },
    onError: (error) => {
      setConfirmState(null);
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить',
        description: describeApiError(error, 'Повторите позже.'),
      });
    },
  });

  const isBusy =
    saveMutation.isPending ||
    publishMutation.isPending ||
    closeMutation.isPending ||
    refreshMutation.isPending ||
    resetPublicationMutation.isPending ||
    deleteMutation.isPending;

  const closeEditorImmediately = useCallback(() => {
    setDraft(null);
    setSavedDraft(null);
    setValidationErrors({ question: '', options: {} });
  }, []);

  const requestEditorClose = useCallback(() => {
    if (!draft || isBusy) {
      return;
    }
    if (isDirty) {
      setConfirmState({ kind: 'discard' });
      return;
    }
    closeEditorImmediately();
  }, [closeEditorImmediately, draft, isBusy, isDirty]);

  const requestPanelClose = useCallback(() => {
    if (isBusy || confirmState) {
      return;
    }
    if (!draft) {
      onClosePanel();
      return;
    }
    if (isDirty) {
      setConfirmState({ kind: 'discard', closePanel: true });
      return;
    }
    closeEditorImmediately();
    onClosePanel();
  }, [closeEditorImmediately, confirmState, draft, isBusy, isDirty, onClosePanel]);

  useImperativeHandle(ref, () => ({ requestClose: requestPanelClose }), [requestPanelClose]);

  useEffect(() => {
    if (!draft) {
      return;
    }

    const scrollContainer = questionRef.current?.closest('.settings-drilldown__body');
    if (scrollContainer instanceof HTMLElement) {
      scrollContainer.scrollTo({ top: 0 });
    }
  }, [draft?.pollId]);

  useNativeBackHandler(
    useCallback(() => {
      if (draft) {
        requestEditorClose();
        return true;
      }
      if (votersPollId) {
        setVotersPollId(null);
        return true;
      }
      return false;
    }, [draft, requestEditorClose, votersPollId]),
    { enabled: Boolean(draft || votersPollId), priority: 650 },
  );

  const startNewPoll = () => {
    if (currentPolls.length > 0) {
      return;
    }
    const nextDraft = createEmptyDraft();
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setValidationErrors({ question: '', options: {} });
  };

  const startEditingPoll = (poll: ManagedPollSummary) => {
    const nextDraft = toEditorDraft(poll);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setValidationErrors({ question: '', options: {} });
  };

  const focusFirstError = (errors: PollValidationErrors) => {
    const target = errors.question
      ? questionRef.current
      : draft?.options.find((option) => errors.options[option.key])
        ? optionRefs.current.get(
            draft.options.find((option) => errors.options[option.key])?.key ?? '',
          )
        : null;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const prepareDraftAction = (): PollEditorDraft | null => {
    if (!draft) {
      return null;
    }
    const errors = validateDraft(draft);
    setValidationErrors(errors);
    if (hasValidationErrors(errors)) {
      window.setTimeout(() => focusFirstError(errors), 0);
      pushToast({ tone: 'danger', title: 'Проверьте опрос' });
      return null;
    }
    return draft;
  };

  const handleSave = () => {
    const validDraft = prepareDraftAction();
    if (validDraft) {
      saveMutation.mutate(validDraft);
    }
  };

  const handlePublish = () => {
    const validDraft = prepareDraftAction();
    if (validDraft) {
      setConfirmState({ kind: 'publish', draft: validDraft });
    }
  };

  const updateDraft = (nextDraft: PollEditorDraft) => {
    setDraft(nextDraft);
    setValidationErrors((current) => ({
      question: nextDraft.question === draft?.question ? current.question : '',
      options: Object.fromEntries(
        Object.entries(current.options).filter(([key]) => {
          const previous = draft?.options.find((option) => option.key === key)?.text;
          const next = nextDraft.options.find((option) => option.key === key)?.text;
          return previous === next;
        }),
      ),
    }));
  };

  const confirmBusy =
    confirmState?.kind === 'publish'
      ? publishMutation.isPending
      : confirmState?.kind === 'close'
        ? closeMutation.isPending
        : confirmState?.kind === 'reset-publication'
          ? resetPublicationMutation.isPending
          : confirmState?.kind === 'delete'
            ? deleteMutation.isPending
            : false;
  const confirmQuestion =
    confirmState?.kind === 'publish'
      ? confirmState.draft.question
      : confirmState && 'poll' in confirmState
        ? confirmState.poll.question
        : (draft?.question ?? '');

  if (draft) {
    return (
      <>
        <PollEditor
          draft={draft}
          errors={validationErrors}
          busy={isBusy}
          questionRef={questionRef}
          optionRefs={optionRefs}
          onChange={updateDraft}
          onBack={requestEditorClose}
          onSave={handleSave}
          onPublish={handlePublish}
        />
        <ActionConfirmSheet
          id="managed-poll-editor-confirm"
          open={confirmState !== null}
          title={
            confirmState?.kind === 'publish'
              ? 'Опубликовать опрос?'
              : confirmState?.kind === 'delete'
                ? 'Удалить черновик?'
                : 'Закрыть редактор?'
          }
          summary={
            confirmState?.kind === 'publish'
              ? 'Опрос появится в канале.'
              : confirmState?.kind === 'delete'
                ? 'Черновик будет удалён.'
                : 'Изменения не сохранятся.'
          }
          previewTitle={confirmQuestion}
          previewMeta={
            confirmState?.kind === 'publish'
              ? `${confirmState.draft.options.length} вариантов · ${
                  confirmState.draft.visibility === 'ANONYMOUS' ? 'анонимный' : 'открытый'
                }`
              : undefined
          }
          confirmLabel={
            confirmState?.kind === 'publish'
              ? 'Опубликовать'
              : confirmState?.kind === 'delete'
                ? 'Удалить'
                : 'Закрыть'
          }
          confirmBusyLabel={confirmState?.kind === 'publish' ? 'Публикуем...' : 'Удаляем...'}
          tone={confirmState?.kind === 'publish' ? 'accent' : 'danger'}
          isBusy={confirmBusy}
          onClose={() => setConfirmState(null)}
          onConfirm={() => {
            if (confirmState?.kind === 'publish') {
              publishMutation.mutate(confirmState.draft);
            } else if (confirmState?.kind === 'delete') {
              deleteMutation.mutate(confirmState.poll.id);
            } else {
              const closePanel =
                confirmState?.kind === 'discard' && confirmState.closePanel === true;
              closeEditorImmediately();
              setConfirmState(null);
              if (closePanel) {
                onClosePanel();
              }
            }
          }}
        />
      </>
    );
  }

  return (
    <section className="managed-poll-workspace">
      <div className="managed-poll-workspace__toolbar">
        <SegmentedControl
          value={tab}
          options={[
            { value: 'current', label: 'Текущие', count: currentPolls.length },
            { value: 'archive', label: 'Архив', count: archivedPolls.length },
          ]}
          onChange={setTab}
          ariaLabel="Опросы"
        />
        <button
          type="button"
          className="managed-poll-workspace__create"
          onClick={startNewPoll}
          disabled={currentPolls.length > 0}
          title={currentPolls.length > 0 ? 'Сначала завершите текущий опрос' : undefined}
        >
          <Plus aria-hidden />
          Новый
        </button>
      </div>

      {pollsQuery.isLoading ? <SkeletonCard lines={5} /> : null}
      {pollsInitialError ? (
        <StatusState
          tone="danger"
          title="Опросы не загрузились"
          description={describeApiError(pollsInitialError, 'Повторите позже.')}
          action={
            <button
              type="button"
              className="managed-poll-action-button"
              onClick={() => void pollsQuery.refetch()}
            >
              Повторить
            </button>
          }
        />
      ) : null}

      {pollsRefreshError ? (
        <div className="managed-poll-workspace__sync-error">
          <span>Не удалось обновить</span>
          <button type="button" onClick={() => void pollsQuery.refetch()}>
            Повторить
          </button>
        </div>
      ) : null}

      {!pollsQuery.isLoading && !pollsInitialError && visiblePolls.length === 0 ? (
        <StatusState
          title={tab === 'current' ? 'Нет текущих опросов' : 'Архив пуст'}
          action={
            tab === 'current' ? (
              <button type="button" className="managed-poll-action-button" onClick={startNewPoll}>
                <Plus aria-hidden />
                Создать
              </button>
            ) : undefined
          }
        />
      ) : null}

      {visiblePolls.length > 0 ? (
        <div className="managed-poll-workspace__list">
          {visiblePolls.map((poll) => (
            <PollResultCard
              key={poll.id}
              api={api}
              channelId={channelId}
              poll={poll}
              votersOpen={votersPollId === poll.id}
              busy={isBusy}
              onEdit={() => startEditingPoll(poll)}
              onClose={() => setConfirmState({ kind: 'close', poll })}
              onDelete={() => setConfirmState({ kind: 'delete', poll })}
              onRefreshPublication={() => refreshMutation.mutate(poll.id)}
              onResetPublication={() => setConfirmState({ kind: 'reset-publication', poll })}
              onToggleVoters={() =>
                setVotersPollId((current) => (current === poll.id ? null : poll.id))
              }
            />
          ))}
        </div>
      ) : null}

      {tab === 'archive' && pollsQuery.hasNextPage ? (
        <button
          type="button"
          className="managed-poll-action-button managed-poll-workspace__more"
          onClick={() => void pollsQuery.fetchNextPage()}
          disabled={pollsQuery.isFetchingNextPage}
        >
          {pollsQuery.isFetchingNextPage ? 'Загрузка...' : 'Показать ещё'}
        </button>
      ) : null}

      <ActionConfirmSheet
        id="managed-poll-list-confirm"
        open={confirmState !== null}
        title={
          confirmState?.kind === 'close'
            ? 'Закрыть опрос?'
            : confirmState?.kind === 'reset-publication'
              ? 'Поста нет в канале?'
              : 'Удалить черновик?'
        }
        summary={
          confirmState?.kind === 'close'
            ? 'Новые голоса больше не принимаются.'
            : confirmState?.kind === 'reset-publication'
              ? 'Черновик будет разблокирован.'
              : 'Черновик будет удалён.'
        }
        previewTitle={confirmQuestion}
        confirmLabel={
          confirmState?.kind === 'close'
            ? 'Закрыть'
            : confirmState?.kind === 'reset-publication'
              ? 'Разблокировать'
              : 'Удалить'
        }
        confirmBusyLabel={
          confirmState?.kind === 'close'
            ? 'Закрываем...'
            : confirmState?.kind === 'reset-publication'
              ? 'Сбрасываем...'
              : 'Удаляем...'
        }
        tone="danger"
        isBusy={confirmBusy}
        onClose={() => setConfirmState(null)}
        onConfirm={() => {
          if (confirmState?.kind === 'close') {
            closeMutation.mutate(confirmState.poll.id);
          } else if (confirmState?.kind === 'reset-publication') {
            resetPublicationMutation.mutate(confirmState.poll.id);
          } else if (confirmState?.kind === 'delete') {
            deleteMutation.mutate(confirmState.poll.id);
          }
        }}
      />
    </section>
  );
});
