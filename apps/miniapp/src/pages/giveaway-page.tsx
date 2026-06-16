import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ManagedGiveawayParticipantState,
  ManagedGiveawayPublic,
  ManagedGiveawayPublicWinner,
} from '@maxim/contracts';
import '../styles/giveaway-page.css';
import type { CSSProperties } from 'react';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
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
  isGiveawayEntryOpen,
  resolveGiveawayDisplayPhase,
  resolveNextGiveawayBoundaryMs,
  shouldPollGiveawayFinalization,
  type GiveawayDisplayPhase,
} from '../lib/giveaway-state';
import {
  closeMaxMiniApp,
  maxImpact,
  maxNotify,
  maxSelectionChanged,
  openMaxBotLink,
} from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { queryKeys } from '../lib/query-keys';

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
  title: string;
  description: string | null;
};

type GiveawayCountdownPresentation = {
  label: string;
  value: string;
  targetAt: string;
};

type GiveawayStatusPresentation = {
  label: string;
  tone: GiveawayTone;
};

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
  displayPhase: GiveawayDisplayPhase | null,
): GiveawayCountdownPresentation | null {
  if (!giveaway) {
    return null;
  }

  if (displayPhase === 'SCHEDULED' && giveaway.startsAt) {
    const startsAtMs = new Date(giveaway.startsAt).getTime();
    if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) {
      return {
        label: 'До старта',
        value: formatCountdownValue(startsAtMs - nowMs),
        targetAt: giveaway.startsAt,
      };
    }
  }

  if (displayPhase === 'ACTIVE' && giveaway.endsAt) {
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

function resolveClaimCountdownPresentation(
  participant: ManagedGiveawayParticipantState | null,
  nowMs: number,
): GiveawayCountdownPresentation | null {
  if (!participant?.canClaim || !participant.claimDeadlineAt) {
    return null;
  }

  const claimDeadlineMs = new Date(participant.claimDeadlineAt).getTime();
  if (!Number.isFinite(claimDeadlineMs) || claimDeadlineMs <= nowMs) {
    return null;
  }

  return {
    label: 'Забрать до',
    value: formatCountdownValue(claimDeadlineMs - nowMs),
    targetAt: participant.claimDeadlineAt,
  };
}

function resolveStatusPresentation(
  displayPhase: GiveawayDisplayPhase | null,
): GiveawayStatusPresentation {
  switch (displayPhase) {
    case 'ACTIVE':
      return { label: 'Активен', tone: 'success' };
    case 'SCHEDULED':
      return { label: 'Скоро', tone: 'muted' };
    case 'DRAWING':
      return { label: 'Итоги', tone: 'warning' };
    case 'COMPLETED':
      return { label: 'Готово', tone: 'success' };
    case 'CANCELED':
      return { label: 'Отменён', tone: 'danger' };
    default:
      return { label: 'Розыгрыш', tone: 'muted' };
  }
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.floor(value / 100_000) / 10}м`;
  }

  if (value >= 10_000) {
    return `${Math.floor(value / 1_000)}к`;
  }

  if (value >= 1_000) {
    return `${Math.floor(value / 100) / 10}к`;
  }

  return String(value);
}

function getGiveawayImageSource(giveaway: ManagedGiveawayPublic): string | null {
  if (!giveaway.imageEnabled || !giveaway.imageBase64 || !giveaway.imageMimeType) {
    return null;
  }

  return `data:${giveaway.imageMimeType};base64,${giveaway.imageBase64}`;
}

function formatWinnerPrizeLine(participant: ManagedGiveawayParticipantState | null): string | null {
  if (!participant?.isWinner) {
    return null;
  }

  const parts = [
    participant.prizePosition ? `${participant.prizePosition} место` : '',
    participant.prizeTitle?.trim() ?? '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' · ') : null;
}

function buildPublicWinnerStatusLabel(status: ManagedGiveawayPublicWinner['status']): string {
  if (status === 'DELIVERED') {
    return 'Выдан';
  }
  if (status === 'CLAIMED') {
    return 'Подтверждён';
  }
  if (status === 'EXPIRED') {
    return 'Истёк';
  }
  if (status === 'REROLLED') {
    return 'Заменён';
  }
  return 'Ожидает';
}

function resolveParticipantStatusPresentation(
  params: Parameters<typeof buildModalPresentation>[0],
): GiveawayModalPresentation {
  const presentation = buildModalPresentation(params);

  if (params.participant?.isWinner) {
    return presentation;
  }

  if (
    params.displayPhase === 'COMPLETED' ||
    params.displayPhase === 'DRAWING' ||
    params.displayPhase === 'CANCELED'
  ) {
    return presentation;
  }

  if (params.participant?.joined && params.participant.eligibilityState === 'VERIFIED') {
    return {
      ...presentation,
      title: 'Участвуете',
    };
  }

  if (params.participant?.joined && params.participant.eligibilityState === 'PENDING') {
    return {
      ...presentation,
      title: 'Проверяем участие',
    };
  }

  if (params.participant?.eligibilityState === 'REJECTED') {
    return {
      ...presentation,
      title: 'Нужно выполнить',
    };
  }

  if (params.displayPhase === 'ACTIVE' && !params.participant?.joined) {
    return {
      ...presentation,
      title: 'Можно участвовать',
    };
  }

  if (params.displayPhase === 'SCHEDULED') {
    return {
      ...presentation,
      title: 'Скоро старт',
    };
  }

  return presentation;
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
      eyebrow: `Условие ${index + 1}`,
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
  displayPhase: GiveawayDisplayPhase;
}): GiveawayModalPresentation {
  const { participant, missingChannelsCount, participantStatusUnavailable, displayPhase } = params;

  if (participantStatusUnavailable) {
    return {
      tone: 'warning',
      glyph: 'clock',
      title: 'Повторите позже',
      description: null,
    };
  }

  if (participant?.isWinner) {
    const winnerStatus = participant.winnerStatus;
    if (winnerStatus === 'EXPIRED') {
      return {
        tone: 'danger',
        glyph: 'clock',
        title: 'Срок истёк',
        description: null,
      };
    }
    if (winnerStatus === 'CLAIMED' || winnerStatus === 'DELIVERED') {
      return {
        tone: 'success',
        glyph: 'gift',
        title: winnerStatus === 'DELIVERED' ? 'Приз выдан' : 'Приз подтверждён',
        description: null,
      };
    }

    return {
      tone: 'success',
      glyph: 'gift',
      title: 'Вы выиграли',
      description: null,
    };
  }

  if (displayPhase === 'COMPLETED') {
    return {
      tone: 'muted',
      glyph: 'check',
      title: 'Итоги готовы',
      description: null,
    };
  }

  if (displayPhase === 'DRAWING') {
    return {
      tone: 'warning',
      glyph: 'clock',
      title: 'Подводим итоги',
      description: null,
    };
  }

  if (displayPhase === 'CANCELED') {
    return {
      tone: 'danger',
      glyph: 'lock',
      title: 'Розыгрыш отменён',
      description: null,
    };
  }

  if (participant?.eligibilityState === 'REJECTED') {
    return {
      tone: 'danger',
      glyph: 'cross',
      title: missingChannelsCount > 1 ? 'Нужны подписки' : 'Нужна подписка',
      description: missingChannelsCount > 0 ? null : participant.eligibilityReason?.trim() || null,
    };
  }

  if (participant?.joined) {
    if (participant.eligibilityState === 'VERIFIED') {
      return {
        tone: 'success',
        glyph: 'check',
        title: 'Условия выполнены',
        description: null,
      };
    }

    return {
      tone: 'warning',
      glyph: 'spark',
      title: 'Проверяем условия',
      description: null,
    };
  }

  if (displayPhase === 'ACTIVE') {
    return {
      tone: 'warning',
      glyph: 'spark',
      title: 'Проверка условий',
      description: null,
    };
  }

  if (displayPhase === 'SCHEDULED') {
    return {
      tone: 'muted',
      glyph: 'clock',
      title: 'Розыгрыш ещё не начался',
      description: null,
    };
  }

  return {
    tone: 'muted',
    glyph: 'check',
    title: 'Приём заявок завершён',
    description: null,
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

function GiveawayDetailsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
      <path d="M6 9.1h12v10.4H6z" strokeLinejoin="round" />
      <path d="M4.8 9.1h14.4M12 9.1v10.4" strokeLinecap="round" />
      <path d="M12 9.1H8.9a2.3 2.3 0 1 1 0-4.6c1.9 0 3.1 2 3.1 4.6Zm0 0h3.1a2.3 2.3 0 1 0 0-4.6c-1.9 0-3.1 2-3.1 4.6Z" />
    </svg>
  );
}

export function GiveawayPage({ api }: { api: ApiTransport }) {
  const { giveawayId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const participantQueryKey = useMemo(
    () => queryKeys.giveawayParticipant(giveawayId),
    [giveawayId],
  );
  const subscriptionCheckInFlightRef = useRef(false);
  const detailsToggleRef = useRef<HTMLButtonElement | null>(null);
  const detailsSheetRef = useRef<HTMLElement | null>(null);
  const detailsReturnFocusRef = useRef<HTMLElement | null>(null);
  const [awaitingSubscriptionReturn, setAwaitingSubscriptionReturn] = useState(false);
  const [subscriptionRecheckPending, setSubscriptionRecheckPending] = useState(false);
  const [subscriptionNeedsManualRetry, setSubscriptionNeedsManualRetry] = useState(false);
  const [participantBootstrapReady, setParticipantBootstrapReady] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
    queryKey: queryKeys.publicGiveaway(giveawayId),
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
        queryClient.invalidateQueries({ queryKey: queryKeys.publicGiveaway(giveawayId) }),
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
      pushToast({
        tone: 'success',
        title: 'Приз подтверждён',
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.publicGiveaway(giveawayId) }),
        queryClient.invalidateQueries({ queryKey: participantQueryKey }),
      ]);
    },
    onError: (error) => {
      maxNotify('error');
      pushToast({
        tone: 'danger',
        title: 'Не удалось забрать приз',
        description: formatApiError(error),
      });
    },
  });

  const giveaway = giveawayQuery.data ?? null;
  const displayPhase = giveaway ? resolveGiveawayDisplayPhase(giveaway, nowMs) : null;
  const entryWindowOpen = giveaway ? isGiveawayEntryOpen(giveaway, nowMs) : false;
  const shouldPollFinalization = giveaway ? shouldPollGiveawayFinalization(giveaway, nowMs) : false;
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
    entryWindowOpen && participant?.eligibilityState === 'REJECTED';
  const canManualEligibilityRecheck =
    entryWindowOpen &&
    (participant?.eligibilityState === 'PENDING' || participant?.eligibilityState === 'REJECTED');
  const canEnterParticipation =
    entryWindowOpen && (!participant?.joined || canRetryRejectedParticipation);

  const loadingPresentation: GiveawayModalPresentation = {
    tone: 'muted',
    glyph: 'clock',
    title: 'Проверка условий',
    description: null,
  };

  const errorPresentation: GiveawayModalPresentation = {
    tone: 'danger',
    glyph: 'cross',
    title: 'Не удалось открыть розыгрыш',
    description: formatApiError(giveawayQuery.error),
  };
  const participantLoadingPresentation: GiveawayModalPresentation = {
    tone: 'muted',
    glyph: 'clock',
    title: 'Проверяем условия',
    description: null,
  };

  const presentation = giveawayQuery.error
    ? errorPresentation
    : giveawayQuery.isLoading || !giveaway
      ? loadingPresentation
      : isParticipantStatusPending
        ? participantLoadingPresentation
        : resolveParticipantStatusPresentation({
            giveaway,
            participant,
            missingChannelsCount: missingChannelCards.length,
            participantStatusUnavailable: Boolean(participantQuery.error),
            displayPhase: displayPhase ?? giveaway.status,
          });
  const countdown = resolveCountdownPresentation(giveaway, nowMs, displayPhase);
  const claimCountdown = resolveClaimCountdownPresentation(participant, nowMs);
  const activeCountdown = claimCountdown ?? countdown;
  const giveawayChannels = giveaway ? buildGiveawayChannels(giveaway) : [];
  const statusPresentation = resolveStatusPresentation(displayPhase);
  const giveawayImageSource = useMemo(
    () => (giveaway ? getGiveawayImageSource(giveaway) : null),
    [giveaway?.id, giveaway?.imageBase64, giveaway?.imageEnabled, giveaway?.imageMimeType],
  );
  const visiblePrizes = giveaway?.prizes.slice(0, 2) ?? [];
  const hiddenPrizeCount = Math.max(0, (giveaway?.prizes.length ?? 0) - visiblePrizes.length);
  const missingChannelIds = new Set(missingChannelCards.map((channel) => channel.id));
  const winnerPrizeLine = formatWinnerPrizeLine(participant);
  const publicWinners = giveaway?.winners.filter((winner) => winner.status !== 'REROLLED') ?? [];
  const showPublicWinners = publicWinners.length > 0;
  const showConditionChecklist = Boolean(
    giveaway &&
    !participant?.isWinner &&
    displayPhase !== 'COMPLETED' &&
    displayPhase !== 'CANCELED' &&
    isSubscriptionFlow &&
    giveawayChannels.length > 0,
  );

  const syncParticipantState = async (nextParticipant: ManagedGiveawayParticipantState) => {
    queryClient.setQueryData(participantQueryKey, nextParticipant);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.publicGiveaway(giveawayId) }),
      queryClient.invalidateQueries({ queryKey: participantQueryKey }),
    ]);
    return nextParticipant;
  };

  const refetchCurrentGiveawayState = useEffectEvent(() => {
    const tasks: Array<Promise<unknown>> = [giveawayQuery.refetch()];
    if (participantBootstrapReady) {
      tasks.push(participantQuery.refetch());
    }

    void Promise.all(tasks);
  });

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
      });
      return;
    }

    setSubscriptionNeedsManualRetry(true);
    maxNotify('warning');

    if (nextParticipant.eligibilityState === 'REJECTED') {
      pushToast({
        tone: 'info',
        title: mode === 'manual' ? 'Подписка ещё не обновилась' : 'MAX ещё обновляет подписку',
      });
      return;
    }

    pushToast({
      tone: 'info',
      title: mode === 'manual' ? 'Проверка ещё не завершена' : 'MAX ещё проверяет участие',
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

  const toggleDetails = () => {
    maxSelectionChanged();
    setDetailsOpen((isOpen) => {
      if (!isOpen && typeof document !== 'undefined') {
        detailsReturnFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : detailsToggleRef.current;
      }
      return !isOpen;
    });
  };

  const closeDetails = () => {
    maxImpact('light');
    setDetailsOpen(false);
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
          : participant?.canClaim
            ? {
                label: claimMutation.isPending ? 'Подтверждаем…' : 'Забрать приз',
                disabled: claimMutation.isPending,
                onClick: () => {
                  void claimMutation.mutateAsync();
                },
              }
            : canManualEligibilityRecheck &&
                (participant?.eligibilityState === 'PENDING' ||
                  subscriptionNeedsManualRetry ||
                  !nextMissingChannel?.link)
              ? {
                  label: subscriptionRecheckPending
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
                          ? 'Открыть следующее условие'
                          : 'Открыть условие',
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
    if (!giveaway || typeof window === 'undefined') {
      return undefined;
    }

    const now = Date.now();
    const boundaryMs = resolveNextGiveawayBoundaryMs(giveaway, now);
    if (boundaryMs === null) {
      return undefined;
    }

    const timerId = window.setTimeout(
      () => {
        setNowMs(Date.now());
        refetchCurrentGiveawayState();
      },
      Math.max(0, boundaryMs - now) + 600,
    );

    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    giveaway?.id,
    giveaway?.status,
    giveaway?.startsAt,
    giveaway?.endsAt,
    refetchCurrentGiveawayState,
  ]);

  useEffect(() => {
    if (!shouldPollFinalization || typeof window === 'undefined') {
      return undefined;
    }

    refetchCurrentGiveawayState();
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
      refetchCurrentGiveawayState();
    }, 5_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [shouldPollFinalization, refetchCurrentGiveawayState]);

  useEffect(() => {
    if (!activeCountdown || typeof window === 'undefined') {
      return undefined;
    }

    setNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [activeCountdown?.targetAt]);

  useEffect(() => {
    if (!participant?.canClaim || !participant.claimDeadlineAt || typeof window === 'undefined') {
      return undefined;
    }

    const claimDeadlineMs = new Date(participant.claimDeadlineAt).getTime();
    if (!Number.isFinite(claimDeadlineMs)) {
      return undefined;
    }

    const timerId = window.setTimeout(
      () => {
        setNowMs(Date.now());
        refetchCurrentGiveawayState();
      },
      Math.max(0, claimDeadlineMs - Date.now()) + 600,
    );

    return () => {
      window.clearTimeout(timerId);
    };
  }, [participant?.canClaim, participant?.claimDeadlineAt, refetchCurrentGiveawayState]);

  useEffect(() => {
    if (giveaway) {
      return;
    }

    setDetailsOpen(false);
  }, [giveaway]);

  useEffect(() => {
    if (!detailsOpen || typeof window === 'undefined') {
      return undefined;
    }

    window.requestAnimationFrame(() => {
      detailsSheetRef.current?.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      closeDetails();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [detailsOpen]);

  useEffect(() => {
    if (detailsOpen || typeof window === 'undefined') {
      return;
    }

    const target = detailsReturnFocusRef.current;
    detailsReturnFocusRef.current = null;
    if (!target) {
      return;
    }

    window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
    });
  }, [detailsOpen]);

  useNativeBackHandler(
    () => {
      closeDetails();
      return true;
    },
    { enabled: detailsOpen, priority: 700 },
  );

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
          tabIndex={-1}
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

          {giveaway ? (
            <button
              ref={detailsToggleRef}
              type="button"
              className={cn('giveaway-page__details-toggle', detailsOpen && 'is-open')}
              aria-label={detailsOpen ? 'Скрыть детали розыгрыша' : 'Показать детали розыгрыша'}
              aria-haspopup="dialog"
              aria-expanded={detailsOpen}
              onClick={toggleDetails}
            >
              <GiveawayDetailsIcon />
            </button>
          ) : null}

          <div className="giveaway-page__overlay-body">
            {giveaway ? (
              <div className="giveaway-page__main-summary">
                <span className={cn('giveaway-page__main-status', `is-${statusPresentation.tone}`)}>
                  {statusPresentation.label}
                </span>
                <h1>{giveaway.title}</h1>
                {giveawayImageSource ? (
                  <img
                    className="giveaway-page__main-image"
                    src={giveawayImageSource}
                    alt={`Обложка розыгрыша: ${giveaway.title}`}
                    loading="eager"
                  />
                ) : null}
                {visiblePrizes.length > 0 ? (
                  <div className="giveaway-page__main-prizes" aria-label="Призы">
                    {visiblePrizes.map((prize) => (
                      <span key={`giveaway-main-prize-${prize.id}`}>
                        <small>{prize.position}</small>
                        <strong>{prize.title}</strong>
                      </span>
                    ))}
                    {hiddenPrizeCount > 0 ? (
                      <span className="giveaway-page__main-prizes-more">
                        <small>+</small>
                        <strong>{hiddenPrizeCount}</strong>
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="giveaway-page__main-metrics" aria-label="Параметры">
                  <span aria-label={`Участники: ${giveaway.entriesCount}`}>
                    <strong>{formatCompactCount(giveaway.entriesCount)}</strong>
                    <small>уч.</small>
                  </span>
                  <span aria-label={`Призы: ${giveaway.prizes.length}`}>
                    <strong>{formatCompactCount(giveaway.prizes.length)}</strong>
                    <small>приз.</small>
                  </span>
                  <span aria-label={`Победители: ${giveaway.winnersCount}`}>
                    <strong>{formatCompactCount(giveaway.winnersCount)}</strong>
                    <small>поб.</small>
                  </span>
                </div>
                {activeCountdown ? (
                  <div className="giveaway-page__main-timer" aria-label={activeCountdown.label}>
                    <span>{activeCountdown.label}</span>
                    <strong>{activeCountdown.value}</strong>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className={cn('giveaway-page__overlay-state-block', `is-${presentation.tone}`)}>
              <GiveawayGlyphIcon tone={presentation.tone} glyph={presentation.glyph} />
              <div className="giveaway-page__overlay-state-copy">
                <strong id="giveaway-overlay-title">{presentation.title}</strong>
                {winnerPrizeLine ? (
                  <span className="giveaway-page__overlay-state-prize">{winnerPrizeLine}</span>
                ) : null}
                {presentation.description ? <p>{presentation.description}</p> : null}
              </div>
            </div>

            {primaryAction ? (
              <div className="giveaway-page__overlay-actions">
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
              </div>
            ) : null}

            {missingChannelCards.length > 0 ? (
              <>
                {totalChannelSteps > 1 ? (
                  <div className="giveaway-page__overlay-progress">
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
              </>
            ) : null}

            {showConditionChecklist ? (
              <div className="giveaway-page__overlay-section">
                <div className="giveaway-page__requirement-list">
                  {giveawayChannels.map((channel, index) => {
                    const isMissing = missingChannelIds.has(channel.id);
                    const canOpenChannel = Boolean(channel.link);

                    if (canOpenChannel) {
                      return (
                        <button
                          key={`giveaway-requirement-${channel.id}`}
                          type="button"
                          className={cn(
                            'giveaway-page__requirement-card',
                            isMissing && 'is-missing',
                          )}
                          onClick={() => {
                            if (isMissing) {
                              openMissingChannel(channel.link ?? '');
                              return;
                            }

                            maxSelectionChanged();
                            openMaxBotLink(channel.link ?? '');
                          }}
                        >
                          <span className="giveaway-page__requirement-index">{index + 1}</span>
                          <span className="giveaway-page__requirement-copy">
                            <span>{channel.eyebrow}</span>
                            <strong>{channel.title}</strong>
                          </span>
                          <span className="giveaway-page__requirement-trailing">
                            <span
                              className={cn(
                                'giveaway-page__requirement-pill',
                                isMissing ? 'is-danger' : 'is-muted',
                              )}
                            >
                              {isMissing ? 'Открыть' : 'Готово'}
                            </span>
                          </span>
                        </button>
                      );
                    }

                    return (
                      <div
                        key={`giveaway-requirement-${channel.id}`}
                        className={cn(
                          'giveaway-page__requirement-card',
                          'is-disabled',
                          isMissing && 'is-missing',
                        )}
                      >
                        <span className="giveaway-page__requirement-index">{index + 1}</span>
                        <span className="giveaway-page__requirement-copy">
                          <span>{channel.eyebrow}</span>
                          <strong>{channel.title}</strong>
                        </span>
                        <span className="giveaway-page__requirement-trailing">
                          <span
                            className={cn(
                              'giveaway-page__requirement-pill',
                              isMissing ? 'is-danger' : 'is-muted',
                            )}
                          >
                            {isMissing ? 'Без ссылки' : 'Готово'}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {detailsOpen && giveaway ? (
            <div className="giveaway-page__details-layer">
              <button
                type="button"
                className="giveaway-page__details-backdrop"
                aria-label="Скрыть детали розыгрыша"
                tabIndex={-1}
                onClick={closeDetails}
              />
              <section
                ref={detailsSheetRef}
                className="giveaway-page__details-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="giveaway-details-title"
                tabIndex={-1}
              >
                <button
                  type="button"
                  className="giveaway-page__details-close"
                  aria-label="Скрыть детали"
                  onClick={closeDetails}
                />
                <div className="giveaway-page__spotlight">
                  <div className="giveaway-page__spotlight-head">
                    <div className="giveaway-page__spotlight-copy">
                      <span
                        className={cn(
                          'giveaway-page__spotlight-status',
                          `is-${statusPresentation.tone}`,
                        )}
                      >
                        {statusPresentation.label}
                      </span>
                      <h1 id="giveaway-details-title">{giveaway.title}</h1>
                    </div>
                    {activeCountdown ? (
                      <div
                        className="giveaway-page__spotlight-timer"
                        aria-label={activeCountdown.label}
                      >
                        <span>{activeCountdown.label}</span>
                        <strong>{activeCountdown.value}</strong>
                      </div>
                    ) : null}
                  </div>

                  <div className="giveaway-page__spotlight-meta" aria-label="Параметры розыгрыша">
                    <span>
                      <strong>{formatCompactCount(giveaway.entriesCount)}</strong>
                      <small>Участники</small>
                    </span>
                    <span>
                      <strong>{formatCompactCount(giveaway.prizes.length)}</strong>
                      <small>Призы</small>
                    </span>
                    <span>
                      <strong>{formatCompactCount(giveaway.winnersCount)}</strong>
                      <small>Победители</small>
                    </span>
                  </div>

                  {giveawayImageSource ? (
                    <img
                      className="giveaway-page__spotlight-image"
                      src={giveawayImageSource}
                      alt={`Обложка розыгрыша: ${giveaway.title}`}
                      loading="eager"
                    />
                  ) : null}

                  {visiblePrizes.length > 0 ? (
                    <div className="giveaway-page__spotlight-prizes" aria-label="Призы">
                      {visiblePrizes.map((prize) => (
                        <span key={prize.id} className="giveaway-page__spotlight-prize">
                          <small>{prize.position}</small>
                          <strong>{prize.title}</strong>
                        </span>
                      ))}
                      {hiddenPrizeCount > 0 ? (
                        <span className="giveaway-page__spotlight-prize giveaway-page__spotlight-prize--more">
                          <small>+</small>
                          <strong>{hiddenPrizeCount}</strong>
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {giveawayChannels.length > 0 ? (
                    <div className="giveaway-page__details-section">
                      <div className="giveaway-page__details-section-head">
                        <strong>Условия</strong>
                        <span>{giveawayChannels.length}</span>
                      </div>
                      <div className="giveaway-page__details-list">
                        {giveawayChannels.map((channel, index) => {
                          const isMissing = missingChannelIds.has(channel.id);
                          const canOpenChannel = Boolean(channel.link);
                          const channelContent = (
                            <>
                              <span className="giveaway-page__details-index">{index + 1}</span>
                              <span className="giveaway-page__details-copy">
                                <small>{channel.eyebrow}</small>
                                <strong>{channel.title}</strong>
                              </span>
                              <span
                                className={cn(
                                  'giveaway-page__details-pill',
                                  isMissing && 'is-missing',
                                )}
                              >
                                {isMissing ? 'Открыть' : 'Готово'}
                              </span>
                            </>
                          );

                          if (canOpenChannel) {
                            return (
                              <button
                                key={`giveaway-details-channel-${channel.id}`}
                                type="button"
                                className={cn(
                                  'giveaway-page__details-row',
                                  isMissing && 'is-missing',
                                )}
                                onClick={() => {
                                  if (isMissing) {
                                    openMissingChannel(channel.link ?? '');
                                    return;
                                  }

                                  maxSelectionChanged();
                                  openMaxBotLink(channel.link ?? '');
                                }}
                              >
                                {channelContent}
                              </button>
                            );
                          }

                          return (
                            <div
                              key={`giveaway-details-channel-${channel.id}`}
                              className={cn(
                                'giveaway-page__details-row',
                                'is-disabled',
                                isMissing && 'is-missing',
                              )}
                            >
                              {channelContent}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {showPublicWinners ? (
                    <div className="giveaway-page__details-section">
                      <div className="giveaway-page__details-section-head">
                        <strong>Победители</strong>
                        <span>{publicWinners.length}</span>
                      </div>
                      <div className="giveaway-page__details-list">
                        {publicWinners.map((winner) => (
                          <div
                            key={`giveaway-public-winner-${winner.prizePosition}-${winner.prizeTitle}`}
                            className="giveaway-page__details-row giveaway-page__details-row--winner"
                          >
                            <span className="giveaway-page__details-index">
                              {winner.prizePosition}
                            </span>
                            <span className="giveaway-page__details-copy">
                              <small>{winner.prizeTitle}</small>
                              <strong>{winner.displayName?.trim() || 'Победитель'}</strong>
                            </span>
                            <span className="giveaway-page__details-pill">
                              {buildPublicWinnerStatusLabel(winner.status)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
