import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { openMaxBotLink } from '../lib/max-bridge';
import type { ApiClient } from '../lib/api-client';
import { useParams } from 'react-router-dom';

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

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'не задано';
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
    return 'Розыгрыш ещё не стартовал';
  }
  if (status === 'COMPLETED') {
    return 'Итоги опубликованы';
  }
  if (status === 'CANCELED') {
    return 'Розыгрыш отменён';
  }
  return 'Розыгрыш обрабатывается';
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

  if (giveawayQuery.isLoading || participantQuery.isLoading) {
    return (
      <div className="giveaway-page">
        <SkeletonCard lines={6} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  if (giveawayQuery.error || participantQuery.error || !giveaway) {
    return (
      <div className="giveaway-page">
        <GlassCard elevated>
          <StatusState
            tone="danger"
            title="Не удалось открыть розыгрыш"
            description={formatApiError(giveawayQuery.error ?? participantQuery.error)}
          />
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="giveaway-page">
      <GlassCard className="giveaway-page__hero" elevated>
        <div className="giveaway-page__eyebrow">{giveaway.sourceTitle}</div>
        <h1>{giveaway.title}</h1>
        <p>{giveaway.description || 'Описание не добавлено.'}</p>
        <div className="giveaway-page__status">{buildStatusLabel(giveaway.status)}</div>
        <div className="giveaway-page__meta">
          <span>Старт: {formatDateTime(giveaway.startsAt)}</span>
          <span>Финиш: {formatDateTime(giveaway.endsAt)}</span>
          <span>Участников: {giveaway.entriesCount}</span>
        </div>
        <div className="giveaway-page__chips">
          {giveaway.prizes.map((prize) => (
            <span key={prize.id} className="giveaway-page__chip">
              {prize.position}. {prize.title}
            </span>
          ))}
        </div>
      </GlassCard>

      <GlassCard elevated>
        <div className="giveaway-page__section-head">
          <h2>Ваш статус</h2>
          {participant?.eligibilityState ? <small>{participant.eligibilityState}</small> : null}
        </div>

        <div className="giveaway-page__participant-copy">
          {participant?.joined ? (
            <p>
              Заявка отправлена {formatDateTime(participant.joinedAt)}.
              {participant.eligibilityReason ? ` ${participant.eligibilityReason}` : ''}
            </p>
          ) : giveaway.status === 'ACTIVE' ? (
            <p>Нажмите кнопку ниже, чтобы участвовать в розыгрыше.</p>
          ) : (
            <p>Приём заявок сейчас закрыт.</p>
          )}

          {participant?.isWinner ? (
            <p>
              Вы победили: {participant.prizePosition}. {participant.prizeTitle}. Статус: {participant.winnerStatus}
              {participant.claimDeadlineAt ? ` · deadline ${formatDateTime(participant.claimDeadlineAt)}` : ''}
            </p>
          ) : null}
        </div>

        <div className="giveaway-page__actions">
          {!participant?.joined && giveaway.status === 'ACTIVE' ? (
            <button
              type="button"
              className="button button--accent"
              disabled={enterMutation.isPending}
              onClick={() => {
                void enterMutation.mutateAsync();
              }}
            >
              Участвовать
            </button>
          ) : null}

          {participant?.canClaim && participant.claimBotUrl ? (
            <button
              type="button"
              className="button button--accent"
              onClick={() => openMaxBotLink(participant.claimBotUrl ?? '')}
            >
              Перейти к claim
            </button>
          ) : null}

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
      </GlassCard>

      {giveaway.status === 'COMPLETED' && giveaway.winners.length > 0 ? (
        <GlassCard elevated>
          <div className="giveaway-page__section-head">
            <h2>Победители</h2>
            <small>{giveaway.winners.length} мест</small>
          </div>
          <div className="giveaway-page__winner-list">
            {giveaway.winners.map((winner) => (
              <div key={`${winner.prizePosition}-${winner.displayName ?? winner.prizeTitle}`} className="giveaway-page__winner-row">
                <strong>
                  {winner.prizePosition}. {winner.prizeTitle}
                </strong>
                <span>{winner.displayName || 'Имя откроется после claim'}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      ) : null}
    </div>
  );
}
