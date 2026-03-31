import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ManagedGiveawayParticipantState, ManagedGiveawayPublic } from '@maxim/contracts';
import type { CSSProperties } from 'react';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../components/ui/toast';
import {
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

type GiveawayCountdownPresentation = {
  label: string;
  value: string;
  targetAt: string;
};

const SUPPORT_BOT_URL = 'https://max.ru/id613002203036_bot';

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

function formatCountdownTarget(value: string | null): string {
  if (!value) {
    return 'без срока';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCountdownValue(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}д ${String(hours).padStart(2, '0')}ч`;
  }

  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function resolveCountdownPresentation(
  giveaway: ManagedGiveawayPublic | null,
  nowMs: number,
): GiveawayCountdownPresentation | null {
  if (!giveaway) {
    return null;
  }

  if (giveaway.status === 'SCHEDULED' && giveaway.startsAt) {
    const startsAtMs = new Date(giveaway.startsAt).getTime();
    if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) {
      return {
        label: 'До старта',
        value: formatCountdownValue(startsAtMs - nowMs),
        targetAt: giveaway.startsAt,
      };
    }
  }

  if (giveaway.status === 'ACTIVE' && giveaway.endsAt) {
    const endsAtMs = new Date(giveaway.endsAt).getTime();
    if (Number.isFinite(endsAtMs) && endsAtMs > nowMs) {
      return {
        label: 'До итогов',
        value: formatCountdownValue(endsAtMs - nowMs),
        targetAt: giveaway.endsAt,
      };
    }
  }

  return null;
}

function buildWinnerStatusLabel(status: string | null | undefined): string | null {
  if (status === 'SELECTED') {
    return 'Победитель объявлен';
  }
  if (status === 'CLAIMED') {
    return 'Победитель объявлен';
  }
  if (status === 'DELIVERED') {
    return 'Приз выдан';
  }
  if (status === 'EXPIRED') {
    return 'Нужен реролл';
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
          ? 'Место можно перевыбрать через админа.'
          : 'Бот уже отправил победителю личное сообщение.',
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
        description: null,
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
    description: giveaway.resultsUrl ? 'Итоги уже в ленте.' : 'Итоги уже зафиксированы.',
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
  const participantQueryKey = useMemo(
    () => ['public-giveaway-participant', giveawayId] as const,
    [giveawayId],
  );
  const subscriptionCheckInFlightRef = useRef(false);
  const [awaitingSubscriptionReturn, setAwaitingSubscriptionReturn] = useState(false);
  const [subscriptionRecheckPending, setSubscriptionRecheckPending] = useState(false);
  const [subscriptionNeedsManualRetry, setSubscriptionNeedsManualRetry] = useState(false);
  const [participantBootstrapReady, setParticipantBootstrapReady] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

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

  useEffect(() => {
    if (!giveawayId) {
      setParticipantBootstrapReady(false);
      return;
    }

    setParticipantBootstrapReady(
      queryClient.getQueryData<ManagedGiveawayParticipantState>(participantQueryKey) !== undefined,
    );
  }, [giveawayId, participantQueryKey, queryClient]);

  const giveawayQuery = useQuery({
    queryKey: ['public-giveaway', giveawayId] as const,
    queryFn: ({ signal }) => getPublicGiveaway(api, giveawayId, { signal }),
    enabled: Boolean(giveawayId),
    refetchOnWindowFocus: false,
  });

  const participantQuery = useQuery({
    queryKey: participantQueryKey,
    queryFn: ({ signal }) => getGiveawayParticipantState(api, giveawayId, { signal }),
    enabled: Boolean(giveawayId) && giveawayQuery.isSuccess && participantBootstrapReady,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!giveawayQuery.data || participantBootstrapReady) {
      return undefined;
    }

    if (typeof window === 'undefined') {
      setParticipantBootstrapReady(true);
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      setParticipantBootstrapReady(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [giveawayQuery.data, participantBootstrapReady]);

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

  const giveaway = giveawayQuery.data ?? null;
  const participant = participantQuery.data ?? null;
  const missingChannelCards =
    giveaway && !participantQuery.error
      ? resolveMissingGiveawayChannels(giveaway, participant)
      : [];
  const totalChannelSteps = giveaway ? buildGiveawayChannels(giveaway).length : 0;
  const completedChannelSteps = Math.max(0, totalChannelSteps - missingChannelCards.length);
  const nextMissingChannel = missingChannelCards[0] ?? null;
  const isParticipantStatusPending =
    Boolean(giveaway) &&
    !participant &&
    !participantQuery.error &&
    (!participantBootstrapReady || participantQuery.isLoading);
  const isSubscriptionFlow =
    participant?.eligibilityState === 'REJECTED' && missingChannelCards.length > 0;

  const canRetryRejectedParticipation =
    giveaway?.status === 'ACTIVE' && participant?.eligibilityState === 'REJECTED';
  const canManualEligibilityRecheck =
    giveaway?.status === 'ACTIVE' &&
    (participant?.eligibilityState === 'PENDING' || participant?.eligibilityState === 'REJECTED');
  const canEnterParticipation =
    giveaway?.status === 'ACTIVE' && (!participant?.joined || canRetryRejectedParticipation);

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
  const participantLoadingPresentation: GiveawayModalPresentation = {
    tone: 'muted',
    glyph: 'clock',
    badge: 'Проверяем статус',
    title: 'Уточняем участие',
    description: 'Проверяем, вступали ли вы раньше и выполнены ли условия.',
  };

  const presentation = giveawayQuery.error
    ? errorPresentation
    : giveawayQuery.isLoading || !giveaway
      ? loadingPresentation
      : isParticipantStatusPending
        ? participantLoadingPresentation
      : buildModalPresentation({
          giveaway,
          participant,
          missingChannelsCount: missingChannelCards.length,
          participantStatusUnavailable: Boolean(participantQuery.error),
        });
  const countdown = resolveCountdownPresentation(giveaway, nowMs);

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

  const applyEligibilityRecheckResult = (
    nextParticipant: ManagedGiveawayParticipantState,
    mode: 'return' | 'manual',
  ) => {
    if (nextParticipant.eligibilityState === 'VERIFIED') {
      maxNotify('success');
      pushToast({
        tone: 'success',
        title: 'Подписка подтверждена',
        description: 'Можно продолжать участие.',
      });
      return;
    }

    setSubscriptionNeedsManualRetry(true);
    maxNotify('warning');

    if (nextParticipant.eligibilityState === 'REJECTED') {
      pushToast({
        tone: 'info',
        title:
          mode === 'manual' ? 'Подписка ещё не обновилась' : 'MAX ещё обновляет подписку',
        description:
          mode === 'manual'
            ? 'Откройте канал ещё раз, если MAX не успел синхронизировать статус.'
            : 'Нажмите «Проверить снова», если подписка уже оформлена.',
      });
      return;
    }

    pushToast({
      tone: 'info',
      title: mode === 'manual' ? 'Проверка ещё не завершена' : 'MAX ещё проверяет участие',
      description:
        mode === 'manual'
          ? 'Подождите пару секунд и нажмите «Проверить снова».'
          : 'Если статус не обновится, нажмите «Проверить снова».',
    });
  };

  const recheckParticipationEligibility = async (mode: 'return' | 'manual') => {
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
        if (latestParticipant.eligibilityState !== 'PENDING') {
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

  const handleSubscriptionReturnVisible = useEffectEvent(() => {
    void recheckParticipationEligibility('return').then((nextParticipant) => {
      if (!nextParticipant) {
        return;
      }

      applyEligibilityRecheckResult(nextParticipant, 'return');
    });
  });

  const primaryAction = giveawayQuery.error
    ? {
        label: 'Повторить',
        disabled: false,
        onClick: () => {
          void giveawayQuery.refetch();
        },
      }
    : !giveaway
      ? null
      : isParticipantStatusPending
        ? {
            label: 'Проверяем статус…',
            disabled: true,
            onClick: () => undefined,
          }
      : participantQuery.error
        ? {
            label: 'Обновить статус',
            disabled: participantQuery.isLoading,
            onClick: () => {
              void participantQuery.refetch();
            },
          }
        : canManualEligibilityRecheck &&
            (participant?.eligibilityState === 'PENDING' ||
              subscriptionNeedsManualRetry ||
              !nextMissingChannel?.link)
          ? {
              label:
                subscriptionRecheckPending
                  ? 'Проверяем статус…'
                  : participant?.eligibilityState === 'PENDING'
                    ? 'Обновить проверку'
                    : 'Проверить снова',
              disabled: subscriptionRecheckPending,
              onClick: () => {
                void recheckParticipationEligibility('manual').then((nextParticipant) => {
                  if (!nextParticipant) {
                    return;
                  }

                  applyEligibilityRecheckResult(nextParticipant, 'manual');
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
              : canEnterParticipation
                ? {
                    label: enterMutation.isPending
                        ? canRetryRejectedParticipation
                          ? 'Проверяем…'
                          : 'Входим…'
                      : canRetryRejectedParticipation
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
    if (
      !awaitingSubscriptionReturn ||
      typeof document === 'undefined' ||
      typeof window === 'undefined'
    ) {
      return undefined;
    }

    const handleVisible = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      handleSubscriptionReturnVisible();
    };

    window.addEventListener('focus', handleVisible);
    window.addEventListener('pageshow', handleVisible);
    document.addEventListener('visibilitychange', handleVisible);

    return () => {
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('pageshow', handleVisible);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [awaitingSubscriptionReturn, handleSubscriptionReturnVisible]);

  useEffect(() => {
    if (!countdown || typeof window === 'undefined') {
      return undefined;
    }

    setNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [countdown?.targetAt]);

  return (
    <div className="giveaway-page giveaway-page--modal-only">
      <div
        className="giveaway-page__overlay giveaway-page__overlay--standalone"
        aria-hidden={false}
      >
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
            {giveaway?.title ? (
              <small className="giveaway-page__overlay-kicker">{giveaway.title}</small>
            ) : null}
            <strong id="giveaway-overlay-title">{presentation.title}</strong>
            {presentation.description ? <p>{presentation.description}</p> : null}
          </div>

          {missingChannelCards.length > 0 ? (
            <div className="giveaway-page__overlay-body">
              {totalChannelSteps > 1 ? (
                <div className="giveaway-page__overlay-progress">
                  <div className="giveaway-page__overlay-progress-head">
                    <strong>
                      Шаг {Math.min(completedChannelSteps + 1, totalChannelSteps)} из{' '}
                      {totalChannelSteps}
                    </strong>
                    <span>Осталось {missingChannelCards.length}</span>
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

            {countdown ? (
              <div
                className="giveaway-page__overlay-timer"
                aria-label={`${countdown.label}: ${countdown.value}. ${formatCountdownTarget(countdown.targetAt)}.`}
              >
                <span>{countdown.label}</span>
                <strong>{countdown.value}</strong>
                <small>{formatCountdownTarget(countdown.targetAt)}</small>
              </div>
            ) : null}
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
              Чат поддержки
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}
