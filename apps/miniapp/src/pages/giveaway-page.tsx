import type { ManagedGiveawayParticipantState } from '@maxim/contracts/giveaway';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle,
  Clock,
  User,
  NavArrowRight,
  RefreshDouble,
  ShieldCheck,
  Trophy,
  Xmark,
} from 'iconoir-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  claimGiveaway,
  enterGiveaway,
  getGiveawayParticipantState,
  getPublicGiveaway,
} from '../lib/api/giveaway-client';
import type { ApiTransport } from '../lib/api/transport';
import {
  buildGiveawayConditions,
  canClaimGiveaway,
  formatGiveawayCountdown,
  isGiveawayEntryOpen,
  resolveGiveawayDisplayPhase,
} from '../lib/giveaway-state';
import { closeMaxMiniApp, maxNotify, openMaxBotLink } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { queryKeys } from '../lib/query-keys';
import { describeUserFacingError } from '../lib/user-facing-error';
import '../styles/giveaway-page.css';

const conditionLabels = {
  unknown: 'Не проверено',
  checking: 'Проверяем',
  verified: 'Подписка подтверждена',
  missing: 'Нужна подписка',
};
const winnerLabels = {
  SELECTED: 'Ожидает подтверждения',
  CLAIMED: 'Подтверждено',
  DELIVERED: 'Выдано',
  EXPIRED: 'Срок истёк',
  REROLLED: 'Заменён',
};
const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

export function GiveawayPage({ api }: { api: ApiTransport }) {
  const { giveawayId = '' } = useParams();
  return <GiveawayParticipation key={giveawayId} api={api} giveawayId={giveawayId} />;
}

function GiveawayParticipation({ api, giveawayId }: { api: ApiTransport; giveawayId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [nowMs, setNowMs] = useState(Date.now);
  const [actionError, setActionError] = useState<string | null>(null);
  const [returnPending, setReturnPending] = useState(false);
  const actionInFlight = useRef(false);
  const awaitingReturn = useRef(false);
  const mounted = useRef(true);
  const clockAnchor = useRef({ server: Date.now(), monotonic: performance.now() });
  const publicKey = queryKeys.publicGiveaway(giveawayId);
  const participantKey = queryKeys.giveawayParticipant(giveawayId);
  const giveawayQuery = useQuery({
    queryKey: publicKey,
    queryFn: async ({ signal }) => {
      const data = await getPublicGiveaway(api, giveawayId, { signal });
      clockAnchor.current = {
        server: data.serverTime ? Date.parse(data.serverTime) : Date.now(),
        monotonic: performance.now(),
      };
      return data;
    },
    enabled: Boolean(giveawayId),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'ACTIVE' || status === 'SCHEDULED' ? 30_000 : false;
    },
  });
  const participantQuery = useQuery({
    queryKey: participantKey,
    queryFn: ({ signal }) => getGiveawayParticipantState(api, giveawayId, { signal }),
    enabled: Boolean(giveawayId) && giveawayQuery.isSuccess,
    refetchOnWindowFocus: () => !actionInFlight.current,
  });
  const giveaway = giveawayQuery.data ?? null;
  const participant = participantQuery.data ?? null;
  const phase = giveaway ? resolveGiveawayDisplayPhase(giveaway, nowMs) : null;
  const entryOpen = giveaway ? isGiveawayEntryOpen(giveaway, nowMs) : false;
  const refreshQueries = () => {
    void queryClient.invalidateQueries({ queryKey: publicKey });
    void queryClient.invalidateQueries({ queryKey: participantKey });
  };
  const refresh = useEffectEvent(refreshQueries);
  useEffect(() => {
    mounted.current = true;
    const tick = () => {
      if (document.visibilityState !== 'hidden')
        setNowMs(clockAnchor.current.server + performance.now() - clockAnchor.current.monotonic);
    };
    const timer = window.setInterval(tick, 1_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  useEffect(() => {
    if (phase) refresh();
  }, [phase]);
  useEffect(() => {
    if (phase !== 'DRAWING') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [phase]);
  const enterMutation = useMutation({
    mutationFn: () => enterGiveaway(api, giveawayId),
    onSuccess: (next: ManagedGiveawayParticipantState) => {
      queryClient.setQueryData(participantKey, next);
      void queryClient.invalidateQueries({ queryKey: publicKey });
      if (mounted.current) maxNotify(next.eligibilityState === 'VERIFIED' ? 'success' : 'warning');
    },
  });
  const claimMutation = useMutation({
    mutationFn: () => claimGiveaway(api, giveawayId),
    onSuccess: () => {
      if (mounted.current) maxNotify('success');
      refreshQueries();
    },
  });
  const runAction = async (kind: 'enter' | 'claim') => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    awaitingReturn.current = false;
    setReturnPending(false);
    setActionError(null);
    try {
      // FLAG: An older GET must not overwrite the result of an explicit check.
      await queryClient.cancelQueries({ queryKey: participantKey });
      if (kind === 'enter') await enterMutation.mutateAsync();
      else await claimMutation.mutateAsync();
    } catch (error) {
      if (mounted.current) {
        setActionError(describeUserFacingError(error, 'Проверка недоступна. Повторите попытку.'));
        maxNotify('error');
        refreshQueries();
      }
    } finally {
      actionInFlight.current = false;
    }
  };
  const onReturn = useEffectEvent(() => {
    if (document.visibilityState === 'hidden' || !awaitingReturn.current || actionInFlight.current)
      return;
    awaitingReturn.current = false;
    setReturnPending(false);
    if (
      giveaway &&
      isGiveawayEntryOpen(
        giveaway,
        clockAnchor.current.server + performance.now() - clockAnchor.current.monotonic,
      )
    )
      void runAction('enter');
    else refresh();
  });
  useEffect(() => {
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, []);
  const close = () => closeMaxMiniApp(() => navigate('/', { replace: true }));
  useNativeBackHandler(
    () => {
      close();
      return true;
    },
    { enabled: true, priority: 500 },
  );
  const checking = enterMutation.isPending;
  const busy = checking || claimMutation.isPending;
  const unavailable = Boolean(participantQuery.error || actionError);
  const conditions = giveaway
    ? buildGiveawayConditions(giveaway, unavailable ? null : participant, checking)
    : [];
  const checkedCount = conditions.filter((condition) => condition.state === 'verified').length;
  const verified =
    participant?.joined && participant.eligibilityState === 'VERIFIED' && !unavailable;
  const claimable = phase === 'COMPLETED' && canClaimGiveaway(participant, nowMs);
  const expired =
    participant?.winnerStatus === 'EXPIRED' ||
    (participant?.winnerStatus === 'SELECTED' &&
      Boolean(participant.claimDeadlineAt) &&
      Date.parse(participant.claimDeadlineAt!) <= nowMs);
  const title = !giveaway
    ? 'Розыгрыш'
    : checking
      ? 'Проверяем условия'
      : unavailable
        ? 'Проверка недоступна'
        : phase === 'CANCELED'
          ? 'Розыгрыш отменён'
          : participant?.isWinner
            ? expired
              ? 'Срок подтверждения истёк'
              : participant.winnerStatus === 'DELIVERED'
                ? 'Приз выдан'
                : participant.winnerStatus === 'CLAIMED'
                  ? 'Выигрыш подтверждён'
                  : 'Вы победили!'
            : phase === 'COMPLETED'
              ? 'Итоги подведены'
              : phase === 'DRAWING'
                ? 'Подводим итоги'
                : phase === 'SCHEDULED'
                  ? 'Скоро начинаем'
                  : verified
                    ? 'Вы участвуете'
                    : participant?.eligibilityState === 'REJECTED'
                      ? 'Осталось подписаться'
                      : participant?.eligibilityState === 'PENDING'
                        ? 'Заявка ожидает проверки'
                        : 'Ваше участие';
  const target = claimable
    ? participant?.claimDeadlineAt
    : phase === 'SCHEDULED'
      ? giveaway?.startsAt
      : phase === 'ACTIVE'
        ? giveaway?.endsAt
        : null;
  const loading = giveawayQuery.isPending || (giveaway && participantQuery.isPending);
  const fatalError = !giveawayId || (!giveaway && giveawayQuery.isError);
  const actionLabel = fatalError
    ? 'Повторить'
    : loading
      ? 'Загружаем статус'
      : busy
        ? checking
          ? 'Проверяем условия'
          : 'Подтверждаем'
        : unavailable
          ? 'Повторить проверку'
          : claimable
            ? 'Подтвердить выигрыш'
            : entryOpen
              ? verified
                ? 'Проверить ещё раз'
                : participant?.joined || returnPending
                  ? 'Проверить подписки'
                  : 'Проверить и участвовать'
              : phase === 'DRAWING'
                ? 'Обновить итоги'
                : 'Обновить статус';
  const showConditions = giveaway && phase !== 'COMPLETED' && phase !== 'CANCELED';
  const StateIcon =
    participant?.isWinner && !expired
      ? Trophy
      : verified
        ? CheckCircle
        : phase === 'DRAWING' || phase === 'SCHEDULED'
          ? Clock
          : ShieldCheck;
  const publicWinners = giveaway?.winners.filter((winner) => winner.status !== 'REROLLED') ?? [];
  return (
    <main className="giveaway-page" data-phase={phase}>
      <div className="giveaway-page__content">
        <header className="giveaway-page__header">
          <img src={`${import.meta.env.BASE_URL}favicon.png`} alt="Майор" width="28" height="28" />
          <span>{giveaway?.sourceTitle ?? 'Розыгрыш'}</span>
          <button
            className="giveaway-page__icon-button"
            type="button"
            onClick={close}
            aria-label="Закрыть розыгрыш"
            title="Закрыть"
          >
            <Xmark />
          </button>
        </header>
        <section
          className="giveaway-page__participation-status"
          aria-busy={Boolean(loading || busy)}
        >
          <div
            className={`giveaway-page__verification ${checking || phase === 'DRAWING' ? 'is-checking' : ''} ${!unavailable && (verified || (participant?.isWinner && !expired)) ? 'is-verified' : ''}`}
            aria-hidden="true"
          >
            <StateIcon />
          </div>
          <p className="giveaway-page__eyebrow">Розыгрыш</p>
          <h1 id="giveaway-overlay-title" aria-live="polite">
            {fatalError ? 'Не удалось открыть розыгрыш' : loading ? 'Загружаем розыгрыш' : title}
          </h1>
          {verified && entryOpen ? (
            <p>Подписки подтверждены. Перед итогами проверим их снова.</p>
          ) : null}
          {phase === 'COMPLETED' && !participant?.isWinner ? (
            <p>
              {participant?.joined
                ? 'В этот раз ваша заявка не выиграла.'
                : 'Приём заявок завершён.'}
            </p>
          ) : null}
          {phase === 'DRAWING' ? <p>Приём заявок закрыт. Ожидаем результаты.</p> : null}
          {participant?.eligibilityState === 'PENDING' && entryOpen ? (
            <p>MAX пока не подтвердил подписки. Заявка сохранена, допуск ещё не подтверждён.</p>
          ) : null}
          {participant?.isWinner && !expired && participant.prizePosition ? (
            <p>{participant.prizePosition} место</p>
          ) : null}
        </section>
        {giveaway ? (
          <section className="giveaway-page__metrics" aria-label="Сроки и заявки">
            {target ? (
              <div className="giveaway-page__timer">
                <span>
                  {claimable
                    ? 'На подтверждение'
                    : phase === 'SCHEDULED'
                      ? 'До начала'
                      : 'До закрытия приёма'}
                </span>
                <strong
                  role="timer"
                  aria-label={formatGiveawayCountdown(Date.parse(target), nowMs)}
                >
                  {formatGiveawayCountdown(Date.parse(target), nowMs)}
                </strong>
                <time dateTime={target}>{dateFormatter.format(new Date(target))}</time>
              </div>
            ) : null}
            <div className="giveaway-page__counts">
              <span>
                <User aria-hidden="true" />
                <strong>{giveaway.entriesCount.toLocaleString('ru-RU')}</strong>
                <small>заявок</small>
              </span>
              <span>
                <Trophy aria-hidden="true" />
                <strong>{giveaway.prizes.length}</strong>
                <small>мест</small>
              </span>
            </div>
          </section>
        ) : null}
        {showConditions ? (
          <section className="giveaway-page__conditions" aria-label="Условия участия">
            <div className="giveaway-page__section-heading">
              <h2>Условия участия</h2>
              <span>
                {checkedCount} из {conditions.length}
              </span>
            </div>
            <div
              className="giveaway-page__progress"
              role="progressbar"
              aria-label="Подтверждённые условия"
              aria-valuemin={0}
              aria-valuemax={conditions.length}
              aria-valuenow={checkedCount}
            >
              {conditions.map((condition) => (
                <span key={condition.id} data-state={condition.state} />
              ))}
            </div>
            <ol className="giveaway-page__condition-list">
              {conditions.map((condition, index) => (
                <li key={condition.id} data-state={condition.state}>
                  <span className="giveaway-page__condition-mark" aria-hidden="true">
                    {condition.state === 'verified' ? (
                      <Check />
                    ) : condition.state === 'checking' ? (
                      <RefreshDouble />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div>
                    <strong>{condition.title}</strong>
                    <small>
                      {conditionLabels[condition.state]}
                      {!condition.link && condition.state !== 'verified'
                        ? ' · Ссылка недоступна'
                        : ''}
                    </small>
                  </div>
                  {condition.link ? (
                    <button
                      type="button"
                      className="giveaway-page__icon-button"
                      aria-label={`Открыть ${condition.title}`}
                      title={`Открыть ${condition.title}`}
                      disabled={busy}
                      onClick={() => {
                        if (entryOpen) {
                          awaitingReturn.current = true;
                          setReturnPending(true);
                        }
                        openMaxBotLink(condition.link!);
                      }}
                    >
                      <NavArrowRight />
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
            {participant?.checkedAt ? (
              <p className="giveaway-page__checked-at">
                Последняя проверка:{' '}
                <time dateTime={participant.checkedAt}>
                  {dateFormatter.format(new Date(participant.checkedAt))}
                </time>
              </p>
            ) : null}
          </section>
        ) : null}
        {participant?.entryId && verified ? (
          <div className="giveaway-page__ticket">
            <CheckCircle aria-hidden="true" />
            <span>
              Заявка принята<strong>№ {participant.entryId}</strong>
            </span>
          </div>
        ) : null}
        {phase === 'COMPLETED' ? (
          <section className="giveaway-page__results">
            <h2>Победители</h2>
            {publicWinners.length ? (
              <ol>
                {publicWinners.map((winner) => (
                  <li key={winner.prizePosition}>
                    <span>{winner.prizePosition}</span>
                    <div>
                      <strong>{winner.displayName || 'Участник'}</strong>
                      <small>{winnerLabels[winner.status]}</small>
                    </div>
                    <Trophy aria-hidden="true" />
                  </li>
                ))}
              </ol>
            ) : (
              <p>Нет участников, допущенных к выбору победителей.</p>
            )}
          </section>
        ) : null}
      </div>
      <footer className="giveaway-page__participation-actions">
        {actionError || participantQuery.error || fatalError ? (
          <p className="giveaway-page__error" role="alert">
            {actionError ??
              describeUserFacingError(
                participantQuery.error ?? giveawayQuery.error,
                'Не удалось загрузить данные. Повторите попытку.',
              )}
          </p>
        ) : null}
        <button
          type="button"
          className="giveaway-page__primary"
          disabled={Boolean(loading || busy || !giveawayId)}
          onClick={() => {
            if (fatalError || (!entryOpen && !claimable) || participantQuery.isError) {
              setActionError(null);
              refreshQueries();
            } else void runAction(claimable ? 'claim' : 'enter');
          }}
        >
          {busy ? (
            <RefreshDouble className="giveaway-page__spin" aria-hidden="true" />
          ) : claimable || verified ? (
            <CheckCircle aria-hidden="true" />
          ) : (
            <ShieldCheck aria-hidden="true" />
          )}
          <span>{actionLabel}</span>
        </button>
        {giveaway?.publicationUrl ? (
          <button
            type="button"
            className="giveaway-page__post-link"
            onClick={() => openMaxBotLink(giveaway.publicationUrl!)}
          >
            К посту розыгрыша
            <NavArrowRight aria-hidden="true" />
          </button>
        ) : null}
      </footer>
    </main>
  );
}
