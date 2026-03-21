import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ManagedGiveawayParticipantState, ManagedGiveawayPublic } from '@maxim/contracts';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  claimGiveaway,
  enterGiveaway,
  getGiveawayParticipantState,
  getPublicGiveaway,
} from '../lib/api/giveaway-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { maxNotify, openMaxBotLink } from '../lib/max-bridge';

type GiveawayTone = 'success' | 'warning' | 'muted' | 'danger';
type GiveawayGlyph = 'spark' | 'check' | 'gift' | 'lock' | 'clock' | 'cross';
type GiveawayChannelCard = {
  id: string;
  eyebrow: string;
  title: string;
  link: string | null;
};

const giveawayHeroStyle: CSSProperties = {
  background:
    'radial-gradient(circle at 100% 0%, rgba(0, 140, 255, 0.24), transparent 36%), radial-gradient(circle at 8% 100%, rgba(43, 203, 163, 0.16), transparent 34%), linear-gradient(155deg, rgba(255, 255, 255, 0.99), rgba(243, 249, 255, 0.96))',
};

const giveawayPanelStyle: CSSProperties = {
  background:
    'radial-gradient(circle at 100% 0%, rgba(142, 197, 255, 0.16), transparent 30%), linear-gradient(160deg, rgba(255, 255, 255, 0.98), rgba(246, 250, 255, 0.96))',
};

const giveawayStatePanelStyle: CSSProperties = {
  background:
    'radial-gradient(circle at 100% 0%, rgba(78, 194, 154, 0.18), transparent 32%), linear-gradient(160deg, rgba(255, 255, 255, 0.98), rgba(244, 250, 248, 0.96))',
};

const giveawayPrizeBlockStyle: CSSProperties = {
  background:
    'linear-gradient(160deg, rgba(250, 252, 255, 0.94), rgba(243, 249, 255, 0.9)), rgba(255, 255, 255, 0.9)',
};

const giveawayStatCardStyle: CSSProperties = {
  background:
    'linear-gradient(160deg, rgba(255, 255, 255, 0.92), rgba(244, 250, 255, 0.9)), rgba(255, 255, 255, 0.92)',
  boxShadow: '0 8px 18px rgba(31, 63, 92, 0.05), 0 1px 0 rgba(255, 255, 255, 0.72) inset',
};

const giveawayArtStyle: CSSProperties = {
  background:
    'radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.2), transparent 32%), linear-gradient(155deg, #0f2740, #19395b 42%, #0d5ab0 100%)',
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)',
};

const giveawayArtCardStyle: CSSProperties = {
  background:
    'linear-gradient(160deg, rgba(255, 255, 255, 0.98), rgba(231, 243, 255, 0.9)), rgba(255, 255, 255, 0.96)',
  boxShadow: '0 22px 40px rgba(4, 16, 29, 0.3), 0 1px 0 rgba(255, 255, 255, 0.84) inset',
};

const giveawayStepCardStyle: CSSProperties = {
  background:
    'linear-gradient(160deg, rgba(255, 255, 255, 0.96), rgba(244, 249, 255, 0.9)), rgba(255, 255, 255, 0.92)',
};

const giveawayChannelCardStyle: CSSProperties = {
  background:
    'linear-gradient(160deg, rgba(255, 255, 255, 0.97), rgba(246, 250, 255, 0.92)), rgba(255, 255, 255, 0.94)',
};

const giveawayWinnerRowStyle: CSSProperties = {
  background:
    'linear-gradient(160deg, rgba(255, 255, 255, 0.96), rgba(244, 249, 255, 0.9)), rgba(255, 255, 255, 0.92)',
};

const giveawayStickyBarStyle: CSSProperties = {
  background:
    'radial-gradient(circle at 0% 100%, rgba(88, 198, 162, 0.16), transparent 34%), linear-gradient(160deg, rgba(255, 255, 255, 0.97), rgba(239, 247, 255, 0.94))',
  boxShadow: '0 22px 42px rgba(18, 45, 69, 0.16)',
};

const giveawayStateCardToneStyles: Record<GiveawayTone, CSSProperties> = {
  success: {
    borderColor: 'rgba(33, 160, 118, 0.18)',
    background:
      'linear-gradient(160deg, rgba(236, 255, 249, 0.94), rgba(246, 255, 252, 0.9)), rgba(255, 255, 255, 0.88)',
  },
  warning: {
    borderColor: 'rgba(226, 160, 56, 0.2)',
    background:
      'linear-gradient(160deg, rgba(255, 249, 236, 0.94), rgba(255, 252, 245, 0.9)), rgba(255, 255, 255, 0.88)',
  },
  danger: {
    borderColor: 'rgba(212, 89, 96, 0.2)',
    background:
      'linear-gradient(160deg, rgba(255, 242, 243, 0.94), rgba(255, 249, 249, 0.9)), rgba(255, 255, 255, 0.88)',
  },
  muted: {
    borderColor: 'rgba(78, 109, 141, 0.14)',
    background:
      'linear-gradient(160deg, rgba(245, 248, 251, 0.94), rgba(249, 251, 253, 0.92)), rgba(255, 255, 255, 0.88)',
  },
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

function formatCompactDateTime(value: string | null, fallback = 'не задано'): string {
  if (!value) {
    return fallback;
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

function formatCount(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatTimeLeft(value: string): string {
  const parsed = new Date(value);
  const targetTime = parsed.getTime();
  if (Number.isNaN(targetTime)) {
    return 'Срок уточняется';
  }

  const diffMs = targetTime - Date.now();
  if (diffMs <= 0) {
    return 'Финиш уже прошёл';
  }

  const totalMinutes = Math.max(1, Math.floor(diffMs / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `Осталось ${days}д ${hours}ч`;
  }

  if (hours > 0) {
    return `Осталось ${hours}ч ${minutes}м`;
  }

  return `Осталось ${minutes}м`;
}

function buildStatusLabel(status: string): string {
  if (status === 'ACTIVE') {
    return 'Приём открыт';
  }
  if (status === 'SCHEDULED') {
    return 'Скоро старт';
  }
  if (status === 'COMPLETED') {
    return 'Итоги готовы';
  }
  if (status === 'CANCELED') {
    return 'Розыгрыш отменён';
  }
  return 'Идёт подсчёт';
}

function buildStatusTone(status: string): GiveawayTone {
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
    return 'Условия подтверждены';
  }
  if (state === 'PENDING') {
    return 'Проверка участия';
  }
  if (state === 'REJECTED') {
    return 'Условия не выполнены';
  }
  return null;
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

function buildWinnerStatusTone(status: string | null | undefined): GiveawayTone {
  if (status === 'SELECTED' || status === 'CLAIMED' || status === 'DELIVERED') {
    return 'success';
  }
  if (status === 'EXPIRED') {
    return 'danger';
  }
  return 'muted';
}

function buildParticipantBadge(params: {
  joined: boolean;
  isWinner: boolean;
  canClaim: boolean;
  winnerStatus: string | null | undefined;
  eligibilityState: string | null | undefined;
  giveawayStatus: string;
}): { label: string; tone: GiveawayTone } {
  if (params.isWinner && params.canClaim) {
    return { label: 'Выигрыш ждёт подтверждения', tone: 'success' };
  }

  if (params.isWinner) {
    return {
      label: buildWinnerStatusLabel(params.winnerStatus) ?? 'Вы в числе победителей',
      tone: params.winnerStatus === 'EXPIRED' ? 'danger' : 'success',
    };
  }

  if (params.joined) {
    if (params.eligibilityState === 'VERIFIED') {
      return { label: 'Вы участвуете', tone: 'success' };
    }
    if (params.eligibilityState === 'REJECTED') {
      return { label: 'Нужно доподписаться', tone: 'danger' };
    }
    return { label: 'Проверяем условия', tone: 'warning' };
  }

  if (params.giveawayStatus === 'ACTIVE') {
    return { label: 'Можно участвовать', tone: 'warning' };
  }

  if (params.giveawayStatus === 'SCHEDULED') {
    return { label: 'Ждём старт', tone: 'muted' };
  }

  if (params.giveawayStatus === 'CANCELED') {
    return { label: 'Розыгрыш отменён', tone: 'danger' };
  }

  return { label: 'Приём закрыт', tone: 'muted' };
}

function buildParticipantPresentation(params: {
  joined: boolean;
  isWinner: boolean;
  canClaim: boolean;
  winnerStatus: string | null | undefined;
  eligibilityState: string | null | undefined;
  eligibilityReason: string | null | undefined;
  giveawayStatus: string;
  prizePosition: number | null | undefined;
  prizeTitle: string | null | undefined;
  missingChannelsCount: number;
}): { tone: GiveawayTone; glyph: GiveawayGlyph; title: string; description: string } {
  if (params.isWinner && params.canClaim) {
    return {
      tone: 'success',
      glyph: 'gift',
      title: 'Вы в числе победителей',
      description: `Подтвердите ${params.prizePosition} приз${params.prizeTitle ? `: ${params.prizeTitle}` : ''}. После подтверждения админ увидит, что выдачу можно завершать.`,
    };
  }

  if (params.isWinner) {
    return {
      tone: params.winnerStatus === 'EXPIRED' ? 'danger' : 'success',
      glyph: params.winnerStatus === 'EXPIRED' ? 'clock' : 'gift',
      title:
        buildWinnerStatusLabel(params.winnerStatus) ??
        `Вы выиграли ${params.prizePosition} приз${params.prizeTitle ? `: ${params.prizeTitle}` : ''}`,
      description:
        params.winnerStatus === 'EXPIRED'
          ? 'Срок подтверждения уже вышел. Если админ включил перевыбор, место может уйти следующему участнику.'
          : 'Выигрыш зафиксирован. Следите за дальнейшим статусом и инструкцией от бота.',
    };
  }

  if (params.joined) {
    if (params.eligibilityState === 'VERIFIED') {
      return {
        tone: 'success',
        glyph: 'check',
        title: 'Вы уже участвуете в этом розыгрыше',
        description:
          'Заявка зафиксирована. Теперь можно просто дождаться итогов на этой же странице.',
      };
    }

    if (params.eligibilityState === 'REJECTED') {
      return {
        tone: 'danger',
        glyph: 'cross',
        title: 'Вы не подписаны на все каналы',
        description:
          params.missingChannelsCount > 0
            ? 'Подпишитесь на каналы ниже и нажмите кнопку участия снова.'
            : params.eligibilityReason?.trim() ||
              'Проверьте обязательные каналы и попробуйте ещё раз.',
      };
    }

    return {
      tone: 'warning',
      glyph: 'spark',
      title: 'Проверяем выполнение условий',
      description:
        params.eligibilityReason?.trim() ||
        'MAX ещё подтверждает участие. Обычно статус обновляется автоматически без дополнительных действий.',
    };
  }

  if (params.giveawayStatus === 'ACTIVE') {
    return {
      tone: 'warning',
      glyph: 'spark',
      title: 'Можно войти в розыгрыш',
      description:
        'Откройте нужные каналы, проверьте условия и нажмите кнопку участия. После этого статус закрепится здесь.',
    };
  }

  if (params.giveawayStatus === 'SCHEDULED') {
    return {
      tone: 'muted',
      glyph: 'clock',
      title: 'Розыгрыш ещё не стартовал',
      description: 'Карточка уже готова, но кнопка участия станет активной только после старта.',
    };
  }

  if (params.giveawayStatus === 'CANCELED') {
    return {
      tone: 'danger',
      glyph: 'lock',
      title: 'Розыгрыш остановлен',
      description: 'Приём заявок закрыт, новых действий не требуется.',
    };
  }

  return {
    tone: 'muted',
    glyph: 'check',
    title: 'Приём завершён',
    description: 'Итоги уже сформированы. Ниже можно посмотреть победителей и статус выдачи.',
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

function buildGiveawayChannels(giveaway: ManagedGiveawayPublic): GiveawayChannelCard[] {
  return [
    {
      id: giveaway.sourceChatId,
      eyebrow: giveaway.entityType === 'channel' ? 'Канал-источник' : 'Чат или канал-источник',
      title: giveaway.sourceTitle,
      link: giveaway.sourceLink,
    },
    ...giveaway.requiredChannels.map((channel, index) => ({
      id: channel.id,
      eyebrow: `Доп. канал ${index + 1}`,
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
  const targetIds =
    participant.missingChannelIds.length > 0 ? participant.missingChannelIds : fallbackChannelIds;
  const byId = new Map(allChannels.map((channel) => [channel.id, channel] as const));

  return targetIds
    .map((channelId) => byId.get(channelId) ?? null)
    .filter((channel): channel is GiveawayChannelCard => Boolean(channel));
}

export function GiveawayPage({ api }: { api: ApiTransport }) {
  const { giveawayId = '' } = useParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

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
  const [resultOverlayParticipant, setResultOverlayParticipant] =
    useState<ManagedGiveawayParticipantState | null>(null);
  const autoEnterAttemptedGiveawayRef = useRef<string | null>(null);

  const enterMutation = useMutation({
    mutationFn: () => enterGiveaway(api, giveawayId),
    onSuccess: async (nextParticipant) => {
      queryClient.setQueryData(participantQueryKey, nextParticipant);
      setResultOverlayParticipant(nextParticipant);
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['public-giveaway', giveawayId] }),
        queryClient.invalidateQueries({ queryKey: participantQueryKey }),
      ]);
      pushToast({
        tone: 'success',
        title: 'Приз подтверждён',
        description: 'Статус обновлён. Админ увидит подтверждение.',
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
  const heroImageSrc =
    giveaway?.imageEnabled && giveaway.imageBase64
      ? `data:${giveaway.imageMimeType || 'image/jpeg'};base64,${giveaway.imageBase64}`
      : null;

  useEffect(() => {
    setResultOverlayParticipant(null);
  }, [giveawayId]);

  useEffect(() => {
    if (!resultOverlayParticipant || typeof document === 'undefined') {
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
  }, [resultOverlayParticipant]);

  useEffect(() => {
    if (!giveaway || participantQuery.error || giveaway.status !== 'ACTIVE') {
      return;
    }

    if (participantQuery.isLoading || enterMutation.isPending) {
      return;
    }

    const canRetryParticipation = participant?.eligibilityState === 'REJECTED';
    const canEnterParticipation = !participant?.joined || canRetryParticipation;
    if (!canEnterParticipation) {
      return;
    }

    if (autoEnterAttemptedGiveawayRef.current === giveawayId) {
      return;
    }

    autoEnterAttemptedGiveawayRef.current = giveawayId;
    void enterMutation.mutateAsync();
  }, [
    enterMutation,
    giveaway,
    giveawayId,
    participant,
    participantQuery.error,
    participantQuery.isLoading,
  ]);

  if (giveawayQuery.isLoading) {
    return (
      <div className="giveaway-page">
        <SkeletonCard lines={7} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={6} />
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

  const participantBadge = participantQuery.isLoading
    ? { label: 'Проверяем статус', tone: 'muted' as const }
    : participantQuery.error
      ? { label: 'Статус недоступен', tone: 'warning' as const }
      : buildParticipantBadge({
          joined: Boolean(participant?.joined),
          isWinner: Boolean(participant?.isWinner),
          canClaim: Boolean(participant?.canClaim),
          winnerStatus: participant?.winnerStatus,
          eligibilityState: participant?.eligibilityState,
          giveawayStatus: giveaway.status,
        });

  const channelCards = buildGiveawayChannels(giveaway);
  const missingChannelCards = resolveMissingGiveawayChannels(giveaway, participant);
  const overlayMissingChannelCards = resolveMissingGiveawayChannels(
    giveaway,
    resultOverlayParticipant,
  );

  const participantPresentation = participantQuery.error
    ? {
        tone: 'warning' as const,
        glyph: 'clock' as const,
        title: 'Статус временно недоступен',
        description: 'Попробуйте обновить данные через пару секунд.',
      }
    : buildParticipantPresentation({
        joined: Boolean(participant?.joined),
        isWinner: Boolean(participant?.isWinner),
        canClaim: Boolean(participant?.canClaim),
        winnerStatus: participant?.winnerStatus,
        eligibilityState: participant?.eligibilityState,
        eligibilityReason: participant?.eligibilityReason,
        giveawayStatus: giveaway.status,
        prizePosition: participant?.prizePosition,
        prizeTitle: participant?.prizeTitle,
        missingChannelsCount: missingChannelCards.length,
      });
  const overlayPresentation = resultOverlayParticipant
    ? buildParticipantPresentation({
        joined: Boolean(resultOverlayParticipant.joined),
        isWinner: Boolean(resultOverlayParticipant.isWinner),
        canClaim: Boolean(resultOverlayParticipant.canClaim),
        winnerStatus: resultOverlayParticipant.winnerStatus,
        eligibilityState: resultOverlayParticipant.eligibilityState,
        eligibilityReason: resultOverlayParticipant.eligibilityReason,
        giveawayStatus: giveaway.status,
        prizePosition: resultOverlayParticipant.prizePosition,
        prizeTitle: resultOverlayParticipant.prizeTitle,
        missingChannelsCount: overlayMissingChannelCards.length,
      })
    : null;

  const eligibilityLabel =
    participantQuery.isLoading || participantQuery.error
      ? null
      : buildEligibilityLabel(participant?.eligibilityState);
  const winnerStatusLabel =
    participantQuery.isLoading || participantQuery.error
      ? null
      : buildWinnerStatusLabel(participant?.winnerStatus);

  const canRetryParticipation =
    giveaway.status === 'ACTIVE' && participant?.eligibilityState === 'REJECTED';
  const canEnterParticipation =
    giveaway.status === 'ACTIVE' && (!participant?.joined || canRetryParticipation);
  const primaryAction =
    participantQuery.isLoading || participantQuery.error
      ? null
      : participant?.canClaim
        ? {
            label: claimMutation.isPending ? 'Подтверждаем…' : 'Подтвердить выигрыш',
            disabled: claimMutation.isPending,
            onClick: () => {
              void claimMutation.mutateAsync();
            },
          }
        : canEnterParticipation
          ? {
              label: enterMutation.isPending
                ? canRetryParticipation
                  ? 'Проверяем участие…'
                  : 'Подключаем…'
                : canRetryParticipation
                  ? 'Проверить участие снова'
                  : 'Участвовать в розыгрыше',
              disabled: enterMutation.isPending,
              onClick: () => {
                void enterMutation.mutateAsync();
              },
            }
          : null;

  const heroFacts = [
    {
      label: giveaway.status === 'COMPLETED' ? 'Финишировал' : 'Финиш',
      value: formatCompactDateTime(giveaway.endsAt),
    },
    {
      label: 'Заявок',
      value: formatCount(giveaway.entriesCount),
    },
    {
      label: 'Мест',
      value: formatCount(giveaway.prizes.length),
    },
  ];

  const stateFacts = [
    participant?.joinedAt ? `Заявка: ${formatDateTime(participant.joinedAt)}` : null,
    participant?.claimDeadlineAt
      ? `Подтвердить до: ${formatDateTime(participant.claimDeadlineAt)}`
      : null,
    participant?.isWinner && participant?.prizeTitle
      ? `Приз: ${participant.prizePosition}. ${participant.prizeTitle}`
      : null,
    eligibilityLabel,
    winnerStatusLabel && participant?.isWinner ? winnerStatusLabel : null,
  ].filter((item): item is string => Boolean(item));

  const secondaryActions = [
    participant?.canClaim && participant.claimBotUrl
      ? {
          key: 'claim-bot',
          label: 'Открыть чат бота',
          onClick: () => openMaxBotLink(participant.claimBotUrl ?? ''),
        }
      : null,
    giveaway.sourceLink
      ? {
          key: 'source',
          label: 'Открыть источник',
          onClick: () => openMaxBotLink(giveaway.sourceLink ?? ''),
        }
      : null,
    giveaway.publicationUrl
      ? {
          key: 'publication',
          label: 'Публикация',
          onClick: () => openMaxBotLink(giveaway.publicationUrl ?? ''),
        }
      : null,
    giveaway.resultsUrl
      ? {
          key: 'results',
          label: 'Итоги',
          onClick: () => openMaxBotLink(giveaway.resultsUrl ?? ''),
        }
      : null,
  ].filter(
    (
      item,
    ): item is {
      key: string;
      label: string;
      onClick: () => void;
    } => Boolean(item),
  );

  const requirementSteps = [
    {
      index: '01',
      title: 'Проверьте источник',
      description:
        giveaway.entityType === 'channel'
          ? 'Подписка на основной канал обязательна для участия и финальной проверки.'
          : 'Участник должен находиться в исходном чате или канале на момент проверки.',
    },
    {
      index: '02',
      title:
        giveaway.requiredChannels.length > 0
          ? 'Подпишитесь на доп. каналы'
          : 'Дополнительных подписок нет',
      description:
        giveaway.requiredChannels.length > 0
          ? 'Каждый обязательный канал ниже учитывается отдельно. Если чего-то не хватает, бот это увидит.'
          : 'Достаточно соответствовать источнику и нажать кнопку участия.',
    },
    {
      index: '03',
      title: 'Зафиксируйте участие',
      description:
        giveaway.status === 'COMPLETED'
          ? 'Приём уже закрыт, осталось только посмотреть итоги и статусы победителей.'
          : 'После нажатия кнопки заявка появится на этом экране. Победителю здесь же откроется подтверждение.',
    },
  ];
  const stickyCopy = participant?.canClaim
    ? {
        title: 'Подтвердите выигрыш прямо сейчас',
        description: 'После подтверждения бот обновит статус и админ сможет завершить выдачу.',
      }
    : canRetryParticipation
      ? {
          title: 'Нужно закрыть условия участия',
          description: 'Откройте недостающие каналы, подпишитесь и нажмите кнопку участия снова.',
        }
      : {
          title: 'Готовы участвовать?',
          description: 'Один тап зафиксирует заявку и сразу покажет итог проверки поверх экрана.',
        };

  return (
    <div className="giveaway-page">
      <GlassCard className="giveaway-page__hero" elevated style={giveawayHeroStyle}>
        <div className="giveaway-page__hero-grid">
          <div className="giveaway-page__hero-copy">
            <div className="giveaway-page__hero-badges">
              <span
                className={cn('giveaway-page__status', `is-${buildStatusTone(giveaway.status)}`)}
              >
                {buildStatusLabel(giveaway.status)}
              </span>
              <span className={cn('giveaway-page__status', 'is-muted')}>
                {formatTimeLeft(giveaway.endsAt)}
              </span>
            </div>

            <div className="giveaway-page__eyebrow">
              {giveaway.entityType === 'channel' ? 'Канал' : 'Чат'} • {giveaway.sourceTitle}
            </div>
            <h1>{giveaway.title}</h1>
            {giveaway.description.trim() ? <p>{giveaway.description}</p> : null}

            <div className="giveaway-page__stat-grid">
              {heroFacts.map((item) => (
                <div
                  key={item.label}
                  className="giveaway-page__stat-card"
                  style={giveawayStatCardStyle}
                >
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </div>

          {heroImageSrc ? (
            <div className="giveaway-page__cover-wrap">
              <img className="giveaway-page__cover" src={heroImageSrc} alt={giveaway.title} />
            </div>
          ) : (
            <div className="giveaway-page__art" aria-hidden style={giveawayArtStyle}>
              <div className="giveaway-page__art-card" style={giveawayArtCardStyle}>
                <span>Пул призов</span>
                <strong>{formatCount(giveaway.prizes.length)} мест</strong>
                <small>
                  {giveaway.status === 'COMPLETED'
                    ? 'Итоги уже доступны'
                    : 'Участие через один тап'}
                </small>
              </div>
            </div>
          )}
        </div>

        <div className="giveaway-page__prizes-block" style={giveawayPrizeBlockStyle}>
          <div className="giveaway-page__section-head">
            <div className="giveaway-page__section-copy">
              <h2>Что разыгрывается</h2>
              <small>Призы будут назначены по местам после финиша.</small>
            </div>
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

      <GlassCard
        className="giveaway-page__panel giveaway-page__panel--state"
        elevated
        style={giveawayStatePanelStyle}
      >
        <div className="giveaway-page__panel-head">
          <div className="giveaway-page__section-copy">
            <h2>Ваш статус</h2>
            <small>Экран обновляется после участия и подтверждения выигрыша.</small>
          </div>
          <span className={cn('giveaway-page__status', `is-${participantBadge.tone}`)}>
            {participantBadge.label}
          </span>
        </div>

        {participantQuery.isLoading ? (
          <StatusState tone="neutral" title="Проверяем статус" description="Пара секунд." />
        ) : participantQuery.error ? (
          <StatusState
            tone="warning"
            title="Статус недоступен"
            description={formatApiError(participantQuery.error)}
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  void participantQuery.refetch();
                }}
              >
                Обновить
              </button>
            }
          />
        ) : (
          <>
            <div
              className={cn('giveaway-page__state-card', `is-${participantPresentation.tone}`)}
              style={giveawayStateCardToneStyles[participantPresentation.tone]}
            >
              <GiveawayGlyphIcon
                tone={participantPresentation.tone}
                glyph={participantPresentation.glyph}
              />
              <div className="giveaway-page__state-copy">
                <strong>{participantPresentation.title}</strong>
                <p>{participantPresentation.description}</p>
              </div>
            </div>

            {missingChannelCards.length > 0 ? (
              <div className="giveaway-page__missing-panel">
                <div className="giveaway-page__missing-head">
                  <strong>Подпишитесь на каналы:</strong>
                  <small>После подписки нажмите кнопку участия снова.</small>
                </div>
                <div className="giveaway-page__missing-list">
                  {missingChannelCards.map((channel) =>
                    channel.link ? (
                      <button
                        key={channel.id}
                        type="button"
                        className="giveaway-page__missing-item"
                        onClick={() => openMaxBotLink(channel.link ?? '')}
                      >
                        <span>{channel.eyebrow}</span>
                        <strong>{channel.title}</strong>
                      </button>
                    ) : (
                      <div key={channel.id} className="giveaway-page__missing-item is-disabled">
                        <span>{channel.eyebrow}</span>
                        <strong>{channel.title}</strong>
                        <small>У канала нет публичной ссылки для открытия из mini app.</small>
                      </div>
                    ),
                  )}
                </div>
              </div>
            ) : null}

            {stateFacts.length > 0 ? (
              <div className="giveaway-page__fact-list">
                {stateFacts.map((item) => (
                  <span key={item} className="giveaway-page__chip">
                    {item}
                  </span>
                ))}
              </div>
            ) : null}

            {secondaryActions.length > 0 ? (
              <div className="giveaway-page__actions">
                {secondaryActions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className="button button--ghost"
                    onClick={action.onClick}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </GlassCard>

      <GlassCard className="giveaway-page__panel" elevated style={giveawayPanelStyle}>
        <div className="giveaway-page__panel-head">
          <div className="giveaway-page__section-copy">
            <h2>Как пройти в розыгрыш</h2>
            <small>Без серых зон: все условия и точки перехода собраны на одной странице.</small>
          </div>
        </div>

        <div className="giveaway-page__step-grid">
          {requirementSteps.map((step) => (
            <div
              key={step.index}
              className="giveaway-page__step-card"
              style={giveawayStepCardStyle}
            >
              <span className="giveaway-page__step-index">{step.index}</span>
              <strong>{step.title}</strong>
              <p>{step.description}</p>
            </div>
          ))}
        </div>

        <div className="giveaway-page__channel-list">
          {channelCards.map((channel) => (
            <div
              key={channel.id}
              className="giveaway-page__channel-card"
              style={giveawayChannelCardStyle}
            >
              <div className="giveaway-page__channel-copy">
                <span>{channel.eyebrow}</span>
                <strong>{channel.title}</strong>
              </div>
              {channel.link ? (
                <button
                  type="button"
                  className="button button--ghost giveaway-page__channel-action"
                  onClick={() => openMaxBotLink(channel.link ?? '')}
                >
                  Открыть
                </button>
              ) : (
                <span className="giveaway-page__channel-note">Проверка идёт автоматически</span>
              )}
            </div>
          ))}
        </div>
      </GlassCard>

      {giveaway.status === 'COMPLETED' && giveaway.winners.length > 0 ? (
        <GlassCard className="giveaway-page__panel" elevated style={giveawayPanelStyle}>
          <div className="giveaway-page__section-head">
            <div className="giveaway-page__section-copy">
              <h2>Победители</h2>
              <small>Публично показываем только подтверждённые имена и актуальные статусы.</small>
            </div>
            <span className={cn('giveaway-page__status', 'is-muted')}>
              {giveaway.winners.length} мест
            </span>
          </div>
          <div className="giveaway-page__winner-list">
            {giveaway.winners.map((winner) => (
              <div
                key={`${winner.prizePosition}-${winner.displayName ?? winner.prizeTitle}`}
                className="giveaway-page__winner-row"
                style={giveawayWinnerRowStyle}
              >
                <div className="giveaway-page__winner-copy">
                  <strong>
                    {winner.prizePosition}. {winner.prizeTitle}
                  </strong>
                  <span className="giveaway-page__winner-name">
                    {winner.displayName || 'Имя откроется после подтверждения'}
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
        <div className="giveaway-page__sticky-bar" style={giveawayStickyBarStyle}>
          <div className="giveaway-page__sticky-copy">
            <strong>{stickyCopy.title}</strong>
            <span>{stickyCopy.description}</span>
          </div>
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

      {resultOverlayParticipant && overlayPresentation ? (
        <div className="giveaway-page__overlay" aria-hidden={false}>
          <button
            type="button"
            className="giveaway-page__overlay-backdrop"
            aria-label="Закрыть результат участия"
            onClick={() => setResultOverlayParticipant(null)}
          />
          <section
            className={cn('giveaway-page__overlay-card', `is-${overlayPresentation.tone}`)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="giveaway-overlay-title"
          >
            <button
              type="button"
              className="giveaway-page__overlay-close"
              aria-label="Закрыть"
              onClick={() => setResultOverlayParticipant(null)}
            >
              ×
            </button>

            <GiveawayGlyphIcon tone={overlayPresentation.tone} glyph={overlayPresentation.glyph} />

            <div className="giveaway-page__overlay-copy">
              <strong id="giveaway-overlay-title">{overlayPresentation.title}</strong>
              <p>{overlayPresentation.description}</p>
            </div>

            {overlayMissingChannelCards.length > 0 ? (
              <div className="giveaway-page__overlay-body">
                <div className="giveaway-page__overlay-note">
                  <strong>Подпишитесь на каналы:</strong>
                  <span>После подписки нажмите кнопку участия снова.</span>
                </div>
                <div className="giveaway-page__overlay-channel-list">
                  {overlayMissingChannelCards.map((channel) =>
                    channel.link ? (
                      <button
                        key={channel.id}
                        type="button"
                        className="giveaway-page__overlay-channel"
                        onClick={() => openMaxBotLink(channel.link ?? '')}
                      >
                        <span>{channel.eyebrow}</span>
                        <strong>{channel.title}</strong>
                      </button>
                    ) : (
                      <div key={channel.id} className="giveaway-page__overlay-channel is-disabled">
                        <span>{channel.eyebrow}</span>
                        <strong>{channel.title}</strong>
                        <small>У канала нет публичной ссылки для открытия из mini app.</small>
                      </div>
                    ),
                  )}
                </div>
              </div>
            ) : null}

            <small className="giveaway-page__overlay-footer">Конкурсный бот Майор Максимов</small>
          </section>
        </div>
      ) : null}
    </div>
  );
}
