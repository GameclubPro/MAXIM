import {
  MANAGED_POLL_MAX_OPTIONS,
  MANAGED_POLL_MIN_OPTIONS,
  MANAGED_POLL_OPTION_MAX_LENGTH,
  MANAGED_POLL_QUESTION_MAX_LENGTH,
  managedPollSummarySchema,
  type CreateManagedPollRequest,
  type ManagedPollDetails,
  type ManagedPollListResponse,
  type ManagedPollSummary,
  type ManagedPollVoter,
  type ManagedPollVisibility,
} from '@maxim/contracts/poll';
import type { BroadcastImage, ManagedEntityType } from '@maxim/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  CheckCircle,
  Camera,
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
import { stripSupportedMarkdownToPlainText } from '../lib/max-markdown';
import {
  closeManagedPoll,
  createManagedPoll,
  deleteManagedPoll,
  getManagedPoll,
  getManagedPollVoters,
  getManagedPolls,
  publishManagedPoll,
  refreshManagedPollPublication,
  resetManagedPollPublication,
  updateManagedPoll,
} from '../lib/api/managed-polls-client';
import type { ApiTransport } from '../lib/api/transport';
import { managedPollQueryKeys } from '../lib/managed-poll-query-keys';
import { openMaxBotLink } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { describeUserFacingError } from '../lib/user-facing-error';
import { ActionConfirmSheet } from './ui/action-confirm-sheet';
import { BroadcastContentComposer } from './broadcast-content-composer';
import { MaxMarkdownPreview } from './max-markdown-preview';
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
  questionFormat: 'plain' | 'markdown';
  images: BroadcastImage[];
  imageRevision: number;
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
  entityType: ManagedEntityType;
  entityId: string;
  onClosePanel: () => void;
};

let nextPollOptionKey = 1;
let nextPollImageRevision = 1;

function createOptionKey(): string {
  const key = `poll-option-${nextPollOptionKey}`;
  nextPollOptionKey += 1;
  return key;
}

function createImageRevision(): number {
  const revision = nextPollImageRevision;
  nextPollImageRevision += 1;
  return revision;
}

function createEmptyDraft(): PollEditorDraft {
  return {
    pollId: null,
    question: '',
    questionFormat: 'plain',
    images: [],
    imageRevision: createImageRevision(),
    visibility: 'ANONYMOUS',
    options: Array.from({ length: MANAGED_POLL_MIN_OPTIONS }, () => ({
      key: createOptionKey(),
      text: '',
    })),
  };
}

function toEditorDraft(poll: ManagedPollDetails): PollEditorDraft {
  return {
    pollId: poll.id,
    question: poll.question,
    questionFormat: poll.questionFormat,
    images: poll.images.map((image) => ({ ...image })),
    imageRevision: createImageRevision(),
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
    questionFormat: draft.questionFormat,
    images: draft.images,
    visibility: draft.visibility,
    options: draft.options.map((option) => ({
      ...(option.id ? { id: option.id } : {}),
      text: option.text.trim(),
    })),
  };
}

function buildDraftKey(draft: PollEditorDraft | null): string {
  if (!draft) {
    return '';
  }

  return JSON.stringify({
    question: draft.question.trim(),
    questionFormat: draft.questionFormat,
    visibility: draft.visibility,
    options: draft.options.map((option) => ({
      ...(option.id ? { id: option.id } : {}),
      text: option.text.trim(),
    })),
    imageRevision: draft.imageRevision,
  });
}

function normalizeOptionText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
}

function validateDraft(draft: PollEditorDraft): PollValidationErrors {
  const errors: PollValidationErrors = { question: '', options: {} };
  const sourceQuestion = draft.question.trim();
  const question =
    draft.questionFormat === 'markdown'
      ? stripSupportedMarkdownToPlainText(sourceQuestion).trim()
      : sourceQuestion;
  if (!question) {
    errors.question = 'Введите вопрос.';
  } else if (sourceQuestion.length > MANAGED_POLL_QUESTION_MAX_LENGTH) {
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
  const summary = managedPollSummarySchema.parse(poll);
  const pages = current?.pages ?? [{ items: [], nextCursor: null }];
  let found = false;
  const nextPages = pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.id !== poll.id) {
        return item;
      }
      found = true;
      return summary;
    }),
  }));
  if (!found) {
    nextPages[0] = {
      ...(nextPages[0] ?? { nextCursor: null }),
      items: [summary, ...(nextPages[0]?.items ?? [])],
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
  return 'Участник';
}

function PollVoterDetails({
  api,
  entityType,
  entityId,
  poll,
}: {
  api: ApiTransport;
  entityType: ManagedEntityType;
  entityId: string;
  poll: ManagedPollSummary;
}) {
  const votersQuery = useInfiniteQuery({
    queryKey: managedPollQueryKeys.voters(entityType, entityId, poll.id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      getManagedPollVoters(api, entityType, entityId, poll.id, {
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
          <span>
            {describeUserFacingError(votersInitialError, 'Не удалось загрузить участников.')}
          </span>
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
  entityType,
  entityId,
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
  entityType: ManagedEntityType;
  entityId: string;
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
            {poll.visibility === 'ANONYMOUS' ? 'Имена скрыты' : 'Имена видны'}
          </span>
        </div>
        <span className="managed-poll-item__date">{date}</span>
      </header>

      <h3 className="managed-poll-item__question">
        {poll.questionFormat === 'markdown' ? (
          <MaxMarkdownPreview value={poll.question} />
        ) : (
          poll.question
        )}
      </h3>

      {poll.imageCount > 0 ? (
        <span className="managed-poll-item__media-count" aria-label={`Фото: ${poll.imageCount}`}>
          <Camera aria-hidden />
          {poll.imageCount}
        </span>
      ) : null}

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
              Завершить
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
              Обновить публикацию
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
              Вернуть в черновики
            </button>
          ) : null}
        </div>
      </footer>

      {votersOpen ? (
        <PollVoterDetails api={api} entityType={entityType} entityId={entityId} poll={poll} />
      ) : null}
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
  onImagePreparationChange,
  onImageError,
  onBack,
  onSave,
  onPublish,
}: {
  draft: PollEditorDraft;
  errors: PollValidationErrors;
  busy: boolean;
  questionRef: RefObject<HTMLDivElement | null>;
  optionRefs: RefObject<Map<string, HTMLInputElement>>;
  onChange: (draft: PollEditorDraft) => void;
  onImagePreparationChange: (preparing: boolean) => void;
  onImageError: (message: string) => void;
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
          aria-label="Назад к списку"
          title="Назад к списку"
        >
          <NavArrowLeft aria-hidden />
        </button>
        <div>
          <h2>{draft.pollId ? 'Черновик' : 'Новый опрос'}</h2>
          <span>Один ответ</span>
        </div>
      </header>

      <div className="managed-poll-editor__section">
        <div
          ref={questionRef}
          className={`managed-poll-editor__question${errors.question ? ' is-error' : ''}`}
        >
          <span className="managed-poll-editor__label-row">
            <strong>Вопрос</strong>
            <small>
              {draft.question.length}/{MANAGED_POLL_QUESTION_MAX_LENGTH}
            </small>
          </span>
          <BroadcastContentComposer
            className="managed-poll-editor__composer"
            text={draft.question}
            maxLength={MANAGED_POLL_QUESTION_MAX_LENGTH}
            images={draft.images}
            messageAriaLabel="Вопрос опроса"
            textPlaceholder="Ваш вопрос"
            textAriaLabel="Вопрос опроса"
            showToolLabels={false}
            disabled={busy}
            textError={errors.question}
            onTextChange={(question) =>
              onChange({ ...draft, question, questionFormat: 'markdown' })
            }
            onImagesChange={(images) =>
              onChange({ ...draft, images, imageRevision: createImageRevision() })
            }
            onImagePreparationChange={onImagePreparationChange}
            onError={onImageError}
          />
        </div>

        <label className="managed-poll-editor__privacy">
          <span>
            <strong>Анонимный опрос</strong>
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
>(function ManagedPollWorkspace({ api, entityType, entityId, onClosePanel }, ref) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [tab, setTab] = useState<PollWorkspaceTab>('current');
  const [draft, setDraft] = useState<PollEditorDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<PollEditorDraft | null>(null);
  const [validationErrors, setValidationErrors] = useState<PollValidationErrors>({
    question: '',
    options: {},
  });
  const [imagesPreparing, setImagesPreparing] = useState(false);
  const [confirmState, setConfirmState] = useState<PollConfirmState | null>(null);
  const [votersPollId, setVotersPollId] = useState<string | null>(null);
  const questionRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLInputElement>());
  const publishSavedPollRef = useRef<ManagedPollDetails | null>(null);
  const listQueryKey = managedPollQueryKeys.list(entityType, entityId);

  const pollsQuery = useInfiniteQuery({
    queryKey: listQueryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      getManagedPolls(api, entityType, entityId, { cursor: pageParam, limit: 30, signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(entityId),
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
      queryClient.setQueryData(managedPollQueryKeys.details(entityType, entityId, poll.id), poll);
    },
    [entityId, entityType, listQueryKey, queryClient],
  );

  const persistDraft = useCallback(
    (value: PollEditorDraft) => {
      const payload = buildPollPayload(value);
      return value.pollId
        ? updateManagedPoll(api, entityType, entityId, value.pollId, payload)
        : createManagedPoll(api, entityType, entityId, payload);
    },
    [api, entityId, entityType],
  );

  const openPollMutation = useMutation({
    mutationFn: (pollId: string) => getManagedPoll(api, entityType, entityId, pollId),
    onSuccess: (poll) => {
      applyPoll(poll);
      const nextDraft = toEditorDraft(poll);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setValidationErrors({ question: '', options: {} });
      setImagesPreparing(false);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть черновик',
        description: describeUserFacingError(error, 'Повторите позже.'),
      });
    },
  });

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
        description: describeUserFacingError(error, 'Повторите позже.'),
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
      return publishManagedPoll(api, entityType, entityId, saved.id);
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
        const persistedDraft = publishSavedPollRef.current;
        const nextDraft = toEditorDraft(persistedDraft);
        applyPoll(persistedDraft);
        setDraft(nextDraft);
        setSavedDraft(nextDraft);
        setValidationErrors({ question: '', options: {} });
        setImagesPreparing(false);
        void queryClient.invalidateQueries({ queryKey: listQueryKey });
      }
      publishSavedPollRef.current = null;
      setConfirmState(null);
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать',
        description: describeUserFacingError(error, 'Повторите позже.'),
      });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (pollId: string) => closeManagedPoll(api, entityType, entityId, pollId),
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
              title: 'Опрос завершён',
              description: 'Публикация не обновилась. Повторите.',
            }
          : { tone: 'success', title: 'Опрос завершён' },
      );
    },
    onError: (error) => {
      setConfirmState(null);
      pushToast({
        tone: 'danger',
        title: 'Не удалось закрыть',
        description: describeUserFacingError(error, 'Повторите позже.'),
      });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: (pollId: string) =>
      refreshManagedPollPublication(api, entityType, entityId, pollId),
    onSuccess: (refreshed) => {
      applyPoll(refreshed);
      pushToast(
        refreshed.renderRepairNeeded
          ? { tone: 'info', title: 'Публикация пока не обновлена' }
          : { tone: 'success', title: 'Публикация обновлена' },
      );
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить публикацию',
        description: describeUserFacingError(error, 'Повторите позже.'),
      });
    },
  });

  const resetPublicationMutation = useMutation({
    mutationFn: (pollId: string) => resetManagedPollPublication(api, entityType, entityId, pollId),
    onSuccess: (reset) => {
      applyPoll(reset);
      setConfirmState(null);
      pushToast({ tone: 'success', title: 'Опрос снова в черновиках' });
    },
    onError: (error) => {
      setConfirmState(null);
      pushToast({
        tone: 'danger',
        title: 'Не удалось сбросить',
        description: describeUserFacingError(error, 'Повторите позже.'),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (pollId: string) => deleteManagedPoll(api, entityType, entityId, pollId),
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
        queryKey: managedPollQueryKeys.details(entityType, entityId, pollId),
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
        description: describeUserFacingError(error, 'Повторите позже.'),
      });
    },
  });

  const isBusy =
    imagesPreparing ||
    openPollMutation.isPending ||
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
    setImagesPreparing(false);
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
    const nextDraft = createEmptyDraft();
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setValidationErrors({ question: '', options: {} });
    setImagesPreparing(false);
  };

  const startEditingPoll = (poll: ManagedPollSummary) => {
    if (!openPollMutation.isPending) {
      openPollMutation.mutate(poll.id);
    }
  };

  const focusFirstError = (errors: PollValidationErrors) => {
    const target = errors.question
      ? questionRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')
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
  const confirmQuestionFormat =
    confirmState?.kind === 'publish'
      ? confirmState.draft.questionFormat
      : confirmState && 'poll' in confirmState
        ? confirmState.poll.questionFormat
        : (draft?.questionFormat ?? 'plain');
  const confirmQuestionPreview =
    confirmQuestionFormat === 'markdown' ? (
      <MaxMarkdownPreview value={confirmQuestion} />
    ) : (
      confirmQuestion
    );
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
          onImagePreparationChange={setImagesPreparing}
          onImageError={(message) =>
            pushToast({
              tone: 'danger',
              title: 'Фото не добавлено',
              description: message,
            })
          }
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
              ? `Опрос появится ${entityType === 'channel' ? 'в канале' : 'в чате'}.`
              : confirmState?.kind === 'delete'
                ? 'Черновик будет удалён.'
                : 'Изменения не сохранятся.'
          }
          previewTitle={confirmQuestionPreview}
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
      <div className="managed-poll-workspace__toolbar has-create">
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
          disabled={isBusy}
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
          description={describeUserFacingError(pollsInitialError, 'Повторите позже.')}
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
        <StatusState title={tab === 'current' ? 'Нет текущих опросов' : 'Архив пуст'} />
      ) : null}

      {visiblePolls.length > 0 ? (
        <div className="managed-poll-workspace__list">
          {visiblePolls.map((poll) => (
            <PollResultCard
              key={poll.id}
              api={api}
              entityType={entityType}
              entityId={entityId}
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

      {pollsQuery.hasNextPage ? (
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
            ? 'Завершить опрос?'
            : confirmState?.kind === 'reset-publication'
              ? 'Вернуть опрос в черновики?'
              : 'Удалить черновик?'
        }
        summary={
          confirmState?.kind === 'close'
            ? 'Новые голоса больше не принимаются.'
            : confirmState?.kind === 'reset-publication'
              ? 'Черновик будет разблокирован.'
              : 'Черновик будет удалён.'
        }
        previewTitle={confirmQuestionPreview}
        confirmLabel={
          confirmState?.kind === 'close'
            ? 'Завершить'
            : confirmState?.kind === 'reset-publication'
              ? 'Вернуть'
              : 'Удалить'
        }
        confirmBusyLabel={
          confirmState?.kind === 'close'
            ? 'Завершаем...'
            : confirmState?.kind === 'reset-publication'
              ? 'Возвращаем...'
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
