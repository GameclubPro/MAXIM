import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { openMaxBotLink } from '../lib/max-bridge';

function formatApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось выполнить действие.';
  }

  const text = error.message.trim();
  if (!text) {
    return 'Не удалось выполнить действие.';
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось выполнить действие.';
  }

  return text;
}

function formatDateTime(value: string | null, fallback = 'не задано'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildStatusLabel(status: string): string {
  if (status === 'ACTIVE') {
    return 'Приём заявок открыт';
  }
  if (status === 'SCHEDULED') {
    return 'Розыгрыш по таймеру';
  }
  if (status === 'COMPLETED') {
    return 'Итоги опубликованы';
  }
  if (status === 'CANCELED') {
    return 'Розыгрыш отменён';
  }
  return 'Подводим итоги';
}

function buildStatusTone(status: string): 'success' | 'warning' | 'muted' | 'danger' {
  if (status === 'ACTIVE') {
    return 'success';
  }
  if (status === 'SCHEDULED') {
    return 'warning';
  }
  if (status === 'CANCELED') {
    return 'danger';
  }
  return 'muted';
}

function buildEligibilityLabel(state: string | null | undefined): string | null {
  if (state === 'VERIFIED') {
    return 'Проверка пройдена';
  }
  if (state === 'PENDING') {
    return 'Проверка позже';
  }
  if (state === 'REJECTED') {
    return 'Условие не выполнено';
  }
  return null;
}

function buildWinnerStatusLabel(status: string | null | undefined): string | null {
  if (status === 'SELECTED') {
    return 'Победитель';
  }
  if (status === 'CLAIMED') {
    return 'Приз подтверждён';
  }
  if (status === 'DELIVERED') {
    return 'Приз выдан';
  }
  if (status === 'EXPIRED') {
    return 'Claim истёк';
  }
  if (status === 'REROLLED') {
    return 'Перевыбран';
  }
  return null;
}

function buildWinnerStatusTone(status: string | null | undefined): 'success' | 'warning' | 'muted' | 'danger' {
  if (status === 'SELECTED' || status === 'CLAIMED' || status === 'DELIVERED') {
    return 'success';
  }
  if (status === 'EXPIRED') {
    return 'danger';
  }
  if (status === 'REROLLED') {
    return 'muted';
  }
  return 'muted';
}

function buildParticipantStatus(params: {
  joined: boolean;
  isWinner: boolean;
  canClaim: boolean;
  winnerStatus: string | null | undefined;
  eligibilityState: string | null | undefined;
  giveawayStatus: string;
}): { label: string; tone: 'success' | 'warning' | 'muted' | 'danger' } {
  if (params.isWinner && params.canClaim) {
    return { label: 'Нужно подтвердить приз', tone: 'success' };
  }

  if (params.isWinner) {
    return {
      label: buildWinnerStatusLabel(params.winnerStatus) ?? 'Вы в числе победителей',
      tone: params.winnerStatus === 'EXPIRED' ? 'danger' : 'success',
    };
  }

  if (params.joined) {
    if (params.eligibilityState === 'VERIFIED') {
      return { label: 'Заявка принята', tone: 'success' };
    }
    if (params.eligibilityState === 'REJECTED') {
      return { label: 'Заявка отклонена', tone: 'danger' };
    }
    return { label: 'Заявка на проверке', tone: 'warning' };
  }

  if (params.giveawayStatus === 'ACTIVE') {
    return { label: 'Можно участвовать', tone: 'warning' };
  }

  if (params.giveawayStatus === 'SCHEDULED') {
    return { label: 'Ожидает старта', tone: 'muted' };
  }

  if (params.giveawayStatus === 'CANCELED') {
    return { label: 'Розыгрыш отменён', tone: 'danger' };
  }

  return { label: 'Приём заявок закрыт', tone: 'muted' };
}

function buildParticipantSummary(params: {
  joined: boolean;
  isWinner: boolean;
  canClaim: boolean;
  winnerStatus: string | null | undefined;
  eligibilityState: string | null | undefined;
  eligibilityReason: string | null | undefined;
  giveawayStatus: string;
  prizePosition: number | null | undefined;
  prizeTitle: string | null | undefined;
}): string {
  if (params.isWinner && params.canClaim) {
    return `Вы выиграли ${params.prizePosition}. ${params.prizeTitle}. Подтвердите приз в личке бота.`;
  }

  if (params.isWinner) {
    return `Выигрыш: ${params.prizePosition}. ${params.prizeTitle}. ${buildWinnerStatusLabel(params.winnerStatus) ?? 'Статус обновляется'}.`;
  }

  if (params.joined) {
    if (params.eligibilityState === 'VERIFIED') {
      return 'Заявка принята и участвует в розыгрыше.';
    }
    if (params.eligibilityState === 'REJECTED') {
      return params.eligibilityReason?.trim() || 'Условие участия не выполнено.';
    }
    return params.eligibilityReason?.trim() || 'Заявка сохранена, финальная проверка будет позже.';
  }

  if (params.giveawayStatus === 'ACTIVE') {
    return 'Можно войти одним нажатием.';
  }
  if (params.giveawayStatus === 'SCHEDULED') {
    return 'Розыгрыш ещё не стартовал.';
  }
  if (params.giveawayStatus === 'COMPLETED') {
    return 'Приём заявок завершён, смотрите итоги ниже.';
  }
  if (params.giveawayStatus === 'CANCELED') {
    return 'Розыгрыш отменён организатором.';
  }
  return 'Сейчас подводим итоги.';
}

export function GiveawayPage({ api }: { api: ApiClient }) {
  const { giveawayId = '' } = useParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const giveawayQuery = useQuery({
    queryKey: ['public-giveaway', giveawayId] as const,
    queryFn: () => api.getPublicGiveaway(giveawayId),
    enabled: Boolean(giveawayId),
    refetchOnWindowFocus: false,
  });

  const participantQuery = useQuery({
    queryKey: ['public-giveaway-participant', giveawayId] as const,
    queryFn: () => api.getGiveawayParticipantState(giveawayId),
    enabled: Boolean(giveawayId),
    refetchOnWindowFocus: false,
  });

  const enterMutation = useMutation({
    mutationFn: () => api.enterGiveaway(giveawayId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['public-giveaway', giveawayId] }),
        queryClient.invalidateQueries({ queryKey: ['public-giveaway-participant', giveawayId] }),
      ]);
      pushToast({
        tone: 'success',
        title: 'Вы участвуете',
        description: 'Заявка сохранена.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось вступить',
        description: formatApiError(error),
      });
    },
  });

  const giveaway = giveawayQuery.data ?? null;
  const participant = participantQuery.data ?? null;
  const heroImageSrc =
    giveaway?.imageEnabled && giveaway.imageBase64
      ? `data:${giveaway.imageMimeType || 'image/jpeg'};base64,${giveaway.imageBase64}`
      : null;

  if (giveawayQuery.isLoading) {
    return (
      <div className="giveaway-page">
        <SkeletonCard lines={6} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  if (giveawayQuery.error || !giveaway) {
    return (
      <div className="giveaway-page">
        <GlassCard elevated>
          <StatusState
            tone="danger"
            title="Не удалось открыть розыгрыш"
            description={formatApiError(giveawayQuery.error)}
          />
        </GlassCard>
      </div>
    );
  }

  const participantStatus = participantQuery.isLoading
    ? { label: 'Проверяем статус', tone: 'muted' as const }
    : participantQuery.error
    ? { label: 'Статус недоступен', tone: 'warning' as const }
    : buildParticipantStatus({
        joined: Boolean(participant?.joined),
        isWinner: Boolean(participant?.isWinner),
        canClaim: Boolean(participant?.canClaim),
        winnerStatus: participant?.winnerStatus,
        eligibilityState: participant?.eligibilityState,
        giveawayStatus: giveaway.status,
      });
  const participantSummary = participantQuery.error
    ? 'Не удалось загрузить персональный статус. Сам розыгрыш открыт, можно повторить проверку ниже.'
    : buildParticipantSummary({
        joined: Boolean(participant?.joined),
        isWinner: Boolean(participant?.isWinner),
        canClaim: Boolean(participant?.canClaim),
        winnerStatus: participant?.winnerStatus,
        eligibilityState: participant?.eligibilityState,
        eligibilityReason: participant?.eligibilityReason,
        giveawayStatus: giveaway.status,
        prizePosition: participant?.prizePosition,
        prizeTitle: participant?.prizeTitle,
      });
  const eligibilityLabel = participantQuery.isLoading || participantQuery.error
    ? null
    : buildEligibilityLabel(participant?.eligibilityState);
  const winnerStatusLabel = participantQuery.isLoading || participantQuery.error
    ? null
    : buildWinnerStatusLabel(participant?.winnerStatus);

  const primaryAction = participantQuery.isLoading || participantQuery.error
    ? null
    : !participant?.joined && giveaway.status === 'ACTIVE'
      ? {
          label: enterMutation.isPending ? 'Входим…' : 'Участвовать',
          disabled: enterMutation.isPending,
          onClick: () => {
            void enterMutation.mutateAsync();
          },
        }
      : participant?.canClaim && participant.claimBotUrl
        ? {
            label: 'Подтвердить приз в боте',
            disabled: false,
            onClick: () => openMaxBotLink(participant.claimBotUrl ?? ''),
          }
        : null;

  return (
    <div className="giveaway-page">
      <GlassCard className="giveaway-page__hero" elevated>
        <div className="giveaway-page__hero-top">
          <div className="giveaway-page__hero-copy">
            <div className="giveaway-page__eyebrow">{giveaway.sourceTitle}</div>
            <h1>{giveaway.title}</h1>
            {giveaway.description.trim() ? <p>{giveaway.description}</p> : null}
          </div>
          <div className={cn('giveaway-page__status', `is-${buildStatusTone(giveaway.status)}`)}>
            {buildStatusLabel(giveaway.status)}
          </div>
        </div>

        {heroImageSrc ? (
          <div className="giveaway-page__cover-wrap">
            <img className="giveaway-page__cover" src={heroImageSrc} alt={giveaway.title} />
          </div>
        ) : null}

        <div className="giveaway-page__chips">
          <span className="giveaway-page__chip">
            Старт: {formatDateTime(giveaway.startsAt, 'сразу')}
          </span>
          <span className="giveaway-page__chip">Финиш: {formatDateTime(giveaway.endsAt)}</span>
          <span className="giveaway-page__chip">{giveaway.entriesCount} заявок</span>
          <span className="giveaway-page__chip">{giveaway.prizes.length} мест</span>
        </div>

        <div className="giveaway-page__prizes-block">
          <div className="giveaway-page__section-head">
            <h2>Призы</h2>
            <small>{giveaway.prizes.length} мест</small>
          </div>
          <div className="giveaway-page__chips">
            {giveaway.prizes.map((prize) => (
              <span key={prize.id} className="giveaway-page__chip">
                {prize.position}. {prize.title}
              </span>
            ))}
          </div>
        </div>
      </GlassCard>

      <GlassCard className="giveaway-page__panel" elevated>
        <div className="giveaway-page__panel-head">
          <h2>Ваш статус</h2>
          <div className="giveaway-page__status-badges">
            <span className={cn('giveaway-page__status', `is-${participantStatus.tone}`)}>
              {participantStatus.label}
            </span>
            {eligibilityLabel ? <small>{eligibilityLabel}</small> : null}
            {winnerStatusLabel && participant?.isWinner ? <small>{winnerStatusLabel}</small> : null}
          </div>
        </div>

        {participantQuery.isLoading ? (
          <StatusState
            tone="neutral"
            title="Проверяем ваш статус"
            description="Подтягиваем участие и eligibility."
          />
        ) : participantQuery.error ? (
          <StatusState
            tone="warning"
            title="Статус пока недоступен"
            description={formatApiError(participantQuery.error)}
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  void participantQuery.refetch();
                }}
              >
                Повторить
              </button>
            }
          />
        ) : (
          <>
            <div className="giveaway-page__status-card">
              <strong>{participantSummary}</strong>
              <div className="giveaway-page__meta">
                {participant?.joinedAt ? <span>Заявка: {formatDateTime(participant.joinedAt)}</span> : null}
                {participant?.claimDeadlineAt ? (
                  <span>Claim до: {formatDateTime(participant.claimDeadlineAt)}</span>
                ) : null}
                {participant?.isWinner && participant?.prizeTitle ? (
                  <span>
                    Приз: {participant.prizePosition}. {participant.prizeTitle}
                  </span>
                ) : null}
              </div>
            </div>

            {giveaway.publicationUrl || giveaway.resultsUrl ? (
              <div className="giveaway-page__actions">
                {giveaway.publicationUrl ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => openMaxBotLink(giveaway.publicationUrl ?? '')}
                  >
                    Открыть пост
                  </button>
                ) : null}

                {giveaway.resultsUrl ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => openMaxBotLink(giveaway.resultsUrl ?? '')}
                  >
                    Итоги
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </GlassCard>

      {giveaway.status === 'COMPLETED' && giveaway.winners.length > 0 ? (
        <GlassCard className="giveaway-page__panel" elevated>
          <div className="giveaway-page__section-head">
            <h2>Победители</h2>
            <small>{giveaway.winners.length} мест</small>
          </div>
          <div className="giveaway-page__winner-list">
            {giveaway.winners.map((winner) => (
              <div
                key={`${winner.prizePosition}-${winner.displayName ?? winner.prizeTitle}`}
                className="giveaway-page__winner-row"
              >
                <div className="giveaway-page__winner-copy">
                  <strong>
                    {winner.prizePosition}. {winner.prizeTitle}
                  </strong>
                  <span className="giveaway-page__winner-name">
                    {winner.displayName || 'Имя откроется после claim'}
                  </span>
                </div>
                <span
                  className={cn(
                    'giveaway-page__status',
                    `is-${buildWinnerStatusTone(winner.status)}`,
                  )}
                >
                  {buildWinnerStatusLabel(winner.status) ?? 'Итоги'}
                </span>
              </div>
            ))}
          </div>
        </GlassCard>
      ) : null}

      {primaryAction ? (
        <div className="giveaway-page__sticky-bar">
          <button
            type="button"
            className="button button--accent"
            disabled={primaryAction.disabled}
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}
