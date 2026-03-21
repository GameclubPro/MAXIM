import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ManagedGiveawayParticipantState, ManagedGiveawayPublic } from '@maxim/contracts';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../components/ui/toast';
import {
  claimGiveaway,
  enterGiveaway,
  getGiveawayParticipantState,
  getPublicGiveaway,
} from '../lib/api/giveaway-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import {
  closeMaxMiniApp,
  maxImpact,
  maxNotify,
  maxSelectionChanged,
  openMaxBotLink,
} from '../lib/max-bridge';

type GiveawayTone = 'success' | 'warning' | 'muted' | 'danger';
type GiveawayGlyph = 'spark' | 'check' | 'gift' | 'lock' | 'clock' | 'cross';
type GiveawayChannelCard = {
  id: string;
  eyebrow: string;
  title: string;
  link: string | null;
};

type GiveawayModalPresentation = {
  tone: GiveawayTone;
  glyph: GiveawayGlyph;
  badge: string;
  title: string;
  description: string | null;
};

const SUPPORT_BOT_URL = 'https://max.ru/id613002203036_4_bot';

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

function buildWinnerStatusLabel(status: string | null | undefined): string | null {
  if (status === 'SELECTED') {
    return 'Нужно подтвердить';
  }
  if (status === 'CLAIMED') {
    return 'Приз подтверждён';
  }
  if (status === 'DELIVERED') {
    return 'Приз выдан';
  }
  if (status === 'EXPIRED') {
    return 'Срок подтверждения истёк';
  }
  if (status === 'REROLLED') {
    return 'Победитель заменён';
  }
  return null;
}

function buildGiveawayChannels(giveaway: ManagedGiveawayPublic): GiveawayChannelCard[] {
  return [
    {
      id: giveaway.sourceChatId,
      eyebrow: giveaway.entityType === 'channel' ? 'Источник' : 'Исходный чат',
      title: giveaway.sourceTitle,
      link: giveaway.sourceLink,
    },
    ...giveaway.requiredChannels.map((channel, index) => ({
      id: channel.id,
      eyebrow: `Канал ${index + 1}`,
      title: channel.title,
      link: channel.link,
    })),
  ];
}

function resolveMissingGiveawayChannels(
  giveaway: ManagedGiveawayPublic,
  participant: ManagedGiveawayParticipantState | null,
): GiveawayChannelCard[] {
  if (!participant || participant.eligibilityState !== 'REJECTED') {
    return [];
  }

  const allChannels = buildGiveawayChannels(giveaway);
  const fallbackChannelIds = allChannels.map((channel) => channel.id);
  const participantMissingChannelIds = Array.isArray(participant.missingChannelIds)
    ? participant.missingChannelIds
    : [];
  const targetIds =
    participantMissingChannelIds.length > 0 ? participantMissingChannelIds : fallbackChannelIds;
  const byId = new Map(allChannels.map((channel) => [channel.id, channel] as const));

  return targetIds
    .map((channelId) => byId.get(channelId) ?? null)
    .filter((channel): channel is GiveawayChannelCard => Boolean(channel));
}

function buildModalPresentation(params: {
  giveaway: ManagedGiveawayPublic;
  participant: ManagedGiveawayParticipantState | null;
  missingChannelsCount: number;
  participantStatusUnavailable: boolean;
}): GiveawayModalPresentation {
  const { giveaway, participant, missingChannelsCount, participantStatusUnavailable } = params;

  if (participantStatusUnavailable) {
    return {
      tone: 'warning',
      glyph: 'clock',
      badge: 'Статус недоступен',
      title: 'Не удалось проверить участие',
      description: 'Повторите чуть позже.',
    };
  }

  if (participant?.canClaim) {
    return {
      tone: 'success',
      glyph: 'gift',
      badge: 'Нужен ответ',
      title: 'Подтвердите выигрыш',
      description: `Подтвердите приз до ${formatDateTime(participant.claimDeadlineAt, 'дедлайна из MAX')}.`,
    };
  }

  if (participant?.isWinner) {
    return {
      tone: participant.winnerStatus === 'EXPIRED' ? 'danger' : 'success',
      glyph: participant.winnerStatus === 'EXPIRED' ? 'clock' : 'gift',
      badge: buildWinnerStatusLabel(participant.winnerStatus) ?? 'Есть результат',
      title:
        participant.prizeTitle && participant.prizePosition
          ? `Выигрыш: ${participant.prizePosition}. ${participant.prizeTitle}`
          : 'Результат уже зафиксирован',
      description:
        participant.winnerStatus === 'EXPIRED'
          ? 'Срок подтверждения истёк.'
          : 'Итоги уже в ленте.',
    };
  }

  if (participant?.eligibilityState === 'REJECTED') {
    return {
      tone: 'danger',
      glyph: 'cross',
      badge: 'Нужно условие',
      title: missingChannelsCount > 1 ? 'Завершите подписку' : 'Подпишитесь и вернитесь',
      description:
        missingChannelsCount > 0
          ? null
          : participant.eligibilityReason?.trim() || 'Попробуйте снова после выполнения условий.',
    };
  }

  if (participant?.joined) {
    if (participant.eligibilityState === 'VERIFIED') {
      return {
        tone: 'success',
        glyph: 'check',
        badge: 'Вы участвуете',
        title: 'Заявка принята',
        description: 'Итоги придут в ленту.',
      };
    }

    return {
      tone: 'warning',
      glyph: 'spark',
      badge: 'Проверяем',
      title: 'Заявка уже отправлена',
      description: 'MAX ещё проверяет подписки.',
    };
  }

  if (giveaway.status === 'ACTIVE') {
    return {
      tone: 'warning',
      glyph: 'spark',
      badge: 'Розыгрыш открыт',
      title: 'Вступить в розыгрыш?',
      description: 'MAX проверит условия автоматически.',
    };
  }

  if (giveaway.status === 'SCHEDULED') {
    return {
      tone: 'muted',
      glyph: 'clock',
      badge: 'Скоро старт',
      title: 'Розыгрыш ещё не начался',
      description: 'Кнопка участия появится после старта.',
    };
  }

  if (giveaway.status === 'CANCELED') {
    return {
      tone: 'danger',
      glyph: 'lock',
      badge: 'Остановлен',
      title: 'Розыгрыш отменён',
      description: 'Действий больше нет.',
    };
  }

  return {
    tone: 'muted',
    glyph: 'check',
    badge: 'Итоги готовы',
    title: 'Приём заявок завершён',
    description: giveaway.resultsUrl
      ? 'Итоги уже в ленте.'
      : 'Итоги уже зафиксированы.',
  };
}

function GiveawayGlyphIcon({ tone, glyph }: { tone: GiveawayTone; glyph: GiveawayGlyph }) {
  return (
    <span className={cn('giveaway-page__state-icon', `is-${tone}`)} aria-hidden>
      {glyph === 'check' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
          <path d="M5.5 12.5 10 17l8.5-9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      {glyph === 'gift' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <path d="M4.5 9.2h15v10.3H4.5z" />
          <path d="M12 9.2v10.3M3.8 9.2h16.4M12 9.2H8.7a2.4 2.4 0 1 1 0-4.8c2 0 3.3 2.1 3.3 4.8Zm0 0h3.3a2.4 2.4 0 1 0 0-4.8C13.3 4.4 12 6.5 12 9.2Z" />
        </svg>
      ) : null}
      {glyph === 'lock' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <rect x="5.2" y="10.1" width="13.6" height="9.7" rx="2.4" />
          <path d="M8.3 10.1V7.8a3.7 3.7 0 0 1 7.4 0v2.3" />
        </svg>
      ) : null}
      {glyph === 'cross' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
          <circle cx="12" cy="12" r="8.2" />
          <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" strokeLinecap="round" />
        </svg>
      ) : null}
      {glyph === 'clock' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7.7v4.7l3 1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      {glyph === 'spark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <path d="m12 3.8 1.8 4.8 4.8 1.8-4.8 1.8L12 17l-1.8-4.8-4.8-1.8 4.8-1.8Z" />
          <path d="m18.3 4.8.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7ZM5 15.8l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z" />
        </svg>
      ) : null}
    </span>
  );
}

export function GiveawayPage({ api }: { api: ApiTransport }) {
  const { giveawayId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const subscriptionCheckInFlightRef = useRef(false);
  const [awaitingSubscriptionReturn, setAwaitingSubscriptionReturn] = useState(false);
  const [subscriptionRecheckPending, setSubscriptionRecheckPending] = useState(false);
  const [subscriptionNeedsManualRetry, setSubscriptionNeedsManualRetry] = useState(false);

  const closePage = () => {
    maxImpact('light');
    closeMaxMiniApp(() => {
      if (window.history.length > 1) {
        navigate(-1);
        return;
      }

      navigate('/', { replace: true });
    });
  };

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, []);

  useEffect(() => {
    maxImpact('soft');
  }, []);

  const giveawayQuery = useQuery({
    queryKey: ['public-giveaway', giveawayId] as const,
    queryFn: () => getPublicGiveaway(api, giveawayId),
    enabled: Boolean(giveawayId),
    refetchOnWindowFocus: false,
  });

  const participantQueryKey = ['public-giveaway-participant', giveawayId] as const;
  const participantQuery = useQuery({
    queryKey: participantQueryKey,
    queryFn: () => getGiveawayParticipantState(api, giveawayId),
    enabled: Boolean(giveawayId),
    refetchOnWindowFocus: false,
  });

  const enterMutation = useMutation({
    mutationFn: () => enterGiveaway(api, giveawayId),
    onSuccess: async (nextParticipant) => {
      queryClient.setQueryData(participantQueryKey, nextParticipant);
      maxNotify(
        nextParticipant.eligibilityState === 'VERIFIED'
          ? 'success'
          : nextParticipant.eligibilityState === 'REJECTED'
            ? 'error'
            : 'warning',
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['public-giveaway', giveawayId] }),
        queryClient.invalidateQueries({ queryKey: participantQueryKey }),
      ]);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось вступить',
        description: formatApiError(error),
      });
    },
  });

  const claimMutation = useMutation({
    mutationFn: () => claimGiveaway(api, giveawayId),
    onSuccess: async () => {
      maxNotify('success');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['public-giveaway', giveawayId] }),
        queryClient.invalidateQueries({ queryKey: participantQueryKey }),
      ]);
      pushToast({
        tone: 'success',
        title: 'Приз подтверждён',
        description: 'Статус обновлён.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось подтвердить приз',
        description: formatApiError(error),
      });
    },
  });

  const giveaway = giveawayQuery.data ?? null;
  const participant = participantQuery.data ?? null;
  const missingChannelCards =
    giveaway && !participantQuery.error
      ? resolveMissingGiveawayChannels(giveaway, participant)
      : [];
  const totalChannelSteps = giveaway ? buildGiveawayChannels(giveaway).length : 0;
  const completedChannelSteps = Math.max(0, totalChannelSteps - missingChannelCards.length);
  const nextMissingChannel = missingChannelCards[0] ?? null;
  const isSubscriptionFlow =
    participant?.eligibilityState === 'REJECTED' && missingChannelCards.length > 0;

  const canRetryParticipation = giveaway?.status === 'ACTIVE' && participant?.eligibilityState === 'REJECTED';
  const canEnterParticipation =
    giveaway?.status === 'ACTIVE' && (!participant?.joined || canRetryParticipation);

  const loadingPresentation: GiveawayModalPresentation = {
    tone: 'muted',
    glyph: 'clock',
    badge: 'Открываем',
    title: 'Подготавливаем розыгрыш',
    description: 'Пара секунд.',
  };

  const errorPresentation: GiveawayModalPresentation = {
    tone: 'danger',
    glyph: 'cross',
    badge: 'Ошибка',
    title: 'Не удалось открыть розыгрыш',
    description: formatApiError(giveawayQuery.error),
  };

  const presentation =
    giveawayQuery.error
      ? errorPresentation
      : giveawayQuery.isLoading || !giveaway
        ? loadingPresentation
        : buildModalPresentation({
            giveaway,
            participant,
            missingChannelsCount: missingChannelCards.length,
            participantStatusUnavailable: Boolean(participantQuery.error),
          });

  const syncParticipantState = async (nextParticipant: ManagedGiveawayParticipantState) => {
    queryClient.setQueryData(participantQueryKey, nextParticipant);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['public-giveaway', giveawayId] }),
      queryClient.invalidateQueries({ queryKey: participantQueryKey }),
    ]);
    return nextParticipant;
  };

  const waitForSubscriptionSync = async (delayMs: number) => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, delayMs);
    });
  };

  const recheckSubscriptionEligibility = async (mode: 'return' | 'manual') => {
    if (!giveawayId || subscriptionCheckInFlightRef.current) {
      return null;
    }

    subscriptionCheckInFlightRef.current = true;
    setSubscriptionRecheckPending(true);
    setSubscriptionNeedsManualRetry(false);

    try {
      const retryDelaysMs = mode === 'return' ? [0, 900, 1800] : [0];
      let latestParticipant: ManagedGiveawayParticipantState | null = null;

      for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) {
          await waitForSubscriptionSync(delayMs);
        }

        latestParticipant = await enterGiveaway(api, giveawayId);
        const missingChannelIds = Array.isArray(latestParticipant.missingChannelIds)
          ? latestParticipant.missingChannelIds
          : [];

        if (
          latestParticipant.eligibilityState === 'VERIFIED' ||
          latestParticipant.canClaim ||
          missingChannelIds.length === 0
        ) {
          break;
        }
      }

      if (latestParticipant) {
        await syncParticipantState(latestParticipant);
      }

      return latestParticipant;
    } catch (error) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось проверить подписку',
        description: formatApiError(error),
      });
      return null;
    } finally {
      subscriptionCheckInFlightRef.current = false;
      setSubscriptionRecheckPending(false);
      setAwaitingSubscriptionReturn(false);
    }
  };

  const openMissingChannel = (url: string) => {
    setAwaitingSubscriptionReturn(true);
    setSubscriptionNeedsManualRetry(false);
    maxSelectionChanged();
    openMaxBotLink(url);
  };

  const primaryAction =
    giveawayQuery.error
      ? {
          label: 'Повторить',
          disabled: false,
          onClick: () => {
            void giveawayQuery.refetch();
          },
        }
      : !giveaway
        ? null
      : participantQuery.error
        ? {
            label: 'Обновить статус',
            disabled: participantQuery.isLoading,
            onClick: () => {
              void participantQuery.refetch();
            },
          }
        : isSubscriptionFlow && subscriptionNeedsManualRetry
          ? {
              label: subscriptionRecheckPending ? 'Проверяем подписку…' : 'Проверить снова',
              disabled: subscriptionRecheckPending,
              onClick: () => {
                void recheckSubscriptionEligibility('manual').then((nextParticipant) => {
                  if (!nextParticipant) {
                    return;
                  }

                  if (nextParticipant.eligibilityState === 'VERIFIED') {
                    maxNotify('success');
                    pushToast({
                      tone: 'success',
                      title: 'Подписка подтверждена',
                      description: 'Можно продолжать участие.',
                    });
                    return;
                  }

                  maxNotify('warning');
                  pushToast({
                    tone: 'info',
                    title: 'Подписка ещё не обновилась',
                    description: 'Откройте канал ещё раз, если MAX не успел синхронизировать статус.',
                  });
                });
              },
            }
          : isSubscriptionFlow && nextMissingChannel?.link
            ? {
                label:
                  awaitingSubscriptionReturn || subscriptionRecheckPending
                    ? 'Проверяем подписку…'
                    : missingChannelCards.length > 1
                      ? 'Открыть следующий канал'
                      : 'Открыть канал',
                disabled: awaitingSubscriptionReturn || subscriptionRecheckPending,
                onClick: () => {
                  openMissingChannel(nextMissingChannel.link ?? '');
                },
              }
            : isSubscriptionFlow
              ? null
              : participant?.canClaim
                ? {
                    label: claimMutation.isPending ? 'Подтверждаем…' : 'Подтвердить приз',
                    disabled: claimMutation.isPending,
                    onClick: () => {
                      void claimMutation.mutateAsync();
                    },
                  }
                : canEnterParticipation
                  ? {
                      label: enterMutation.isPending
                        ? canRetryParticipation
                          ? 'Проверяем…'
                          : 'Входим…'
                        : canRetryParticipation
                          ? 'Проверить снова'
                          : 'Участвовать',
                      disabled: enterMutation.isPending || participantQuery.isLoading,
                      onClick: () => {
                        void enterMutation.mutateAsync();
                      },
                    }
                  : giveaway.resultsUrl
                    ? {
                        label: 'Открыть итоги',
                        disabled: false,
                        onClick: () => {
                          openMaxBotLink(giveaway.resultsUrl ?? '');
                        },
                      }
                    : null;

  const openSupportBot = () => {
    maxSelectionChanged();
    openMaxBotLink(SUPPORT_BOT_URL);
  };

  useEffect(() => {
    if (!awaitingSubscriptionReturn || typeof document === 'undefined' || typeof window === 'undefined') {
      return undefined;
    }

    const handleVisible = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      void recheckSubscriptionEligibility('return').then((nextParticipant) => {
        if (!nextParticipant) {
          return;
        }

        if (nextParticipant.eligibilityState === 'VERIFIED') {
          maxNotify('success');
          pushToast({
            tone: 'success',
            title: 'Подписка подтверждена',
            description: 'Можно продолжать участие.',
          });
          return;
        }

        if (nextParticipant.eligibilityState === 'REJECTED') {
          setSubscriptionNeedsManualRetry(true);
          maxNotify('warning');
          pushToast({
            tone: 'info',
            title: 'MAX ещё обновляет подписку',
            description: 'Нажмите «Проверить снова», если подписка уже оформлена.',
          });
        }
      });
    };

    window.addEventListener('focus', handleVisible);
    window.addEventListener('pageshow', handleVisible);
    document.addEventListener('visibilitychange', handleVisible);

    return () => {
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('pageshow', handleVisible);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [awaitingSubscriptionReturn, giveawayId, participantQueryKey, pushToast, queryClient]);

  return (
    <div className="giveaway-page giveaway-page--modal-only">
      <div className="giveaway-page__overlay giveaway-page__overlay--standalone" aria-hidden={false}>
        <button
          type="button"
          className="giveaway-page__overlay-backdrop"
          aria-label="Закрыть розыгрыш"
          onClick={closePage}
        />

        <section
          className={cn(
            'giveaway-page__overlay-card',
            'giveaway-page__overlay-card--standalone',
            `is-${presentation.tone}`,
          )}
          role="dialog"
          aria-modal="true"
          aria-labelledby="giveaway-overlay-title"
        >
          <div className="giveaway-page__overlay-handle" aria-hidden />

          <button
            type="button"
            className="giveaway-page__overlay-close"
            aria-label="Закрыть"
            onClick={closePage}
          >
            ×
          </button>

          <span className={cn('giveaway-page__status', `is-${presentation.tone}`)}>
            {presentation.badge}
          </span>

          <GiveawayGlyphIcon tone={presentation.tone} glyph={presentation.glyph} />

          <div className="giveaway-page__overlay-copy">
            <small className="giveaway-page__overlay-kicker">
              {giveaway ? giveaway.title : 'Розыгрыш'}
            </small>
            <strong id="giveaway-overlay-title">{presentation.title}</strong>
            {presentation.description ? <p>{presentation.description}</p> : null}
          </div>

          {missingChannelCards.length > 0 ? (
            <div className="giveaway-page__overlay-body">
              {totalChannelSteps > 1 ? (
                <div className="giveaway-page__overlay-progress">
                  <div className="giveaway-page__overlay-progress-head">
                    <strong>
                      Шаг {Math.min(completedChannelSteps + 1, totalChannelSteps)} из {totalChannelSteps}
                    </strong>
                    <span>
                      Осталось {missingChannelCards.length}
                    </span>
                  </div>

                  <div
                    className="giveaway-page__overlay-progress-rail"
                    style={{ '--giveaway-progress-count': totalChannelSteps } as CSSProperties}
                    aria-hidden
                  >
                    {Array.from({ length: totalChannelSteps }, (_, index) => (
                      <span
                        key={`giveaway-progress-${index + 1}`}
                        className={cn(
                          'giveaway-page__overlay-progress-segment',
                          index < completedChannelSteps && 'is-complete',
                          index === completedChannelSteps && 'is-current',
                        )}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {nextMissingChannel ? (
                nextMissingChannel.link ? (
                  <button
                    type="button"
                    className="giveaway-page__overlay-channel giveaway-page__overlay-channel--focus"
                    onClick={() => {
                      openMissingChannel(nextMissingChannel.link ?? '');
                    }}
                  >
                    <span>Следующий канал</span>
                    <strong>{nextMissingChannel.title}</strong>
                    <small>
                      {subscriptionNeedsManualRetry
                        ? 'Если нужно, откройте канал ещё раз.'
                        : awaitingSubscriptionReturn || subscriptionRecheckPending
                          ? 'Возвращайтесь в mini app после подписки.'
                          : 'Откройте в MAX и подпишитесь.'}
                    </small>
                  </button>
                ) : (
                  <div className="giveaway-page__overlay-channel is-disabled giveaway-page__overlay-channel--focus">
                    <span>Следующий канал</span>
                    <strong>{nextMissingChannel.title}</strong>
                    <small>У канала нет публичной ссылки.</small>
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          <div className="giveaway-page__overlay-actions">
            {primaryAction ? (
              <button
                type="button"
                className="button button--accent"
                disabled={primaryAction.disabled}
                onClick={() => {
                  maxImpact('medium');
                  primaryAction.onClick();
                }}
              >
                {primaryAction.label}
              </button>
            ) : null}

            <button
              type="button"
              className="button button--ghost giveaway-page__overlay-dismiss"
              onClick={closePage}
            >
              Закрыть
            </button>
          </div>

          <p className="giveaway-page__overlay-footnote">
            Поддержка:{' '}
            <a
              href={SUPPORT_BOT_URL}
              className="giveaway-page__overlay-inline-link"
              onClick={(event) => {
                event.preventDefault();
                openSupportBot();
              }}
            >
              Конкурсный бот Майор Максимов
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}
