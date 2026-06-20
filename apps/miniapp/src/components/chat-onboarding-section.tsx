import { useQuery } from '@tanstack/react-query';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import type { ManagedEntityOnboardingDiagnostics, ManagedEntityType } from '@maxim/contracts';
import { getManagedEntityOnboardingDiagnostics } from '../lib/api/onboarding-diagnostics-client';
import type { ApiTransport } from '../lib/api/transport';
import { queryKeys } from '../lib/query-keys';
import { GlassCard } from './ui/glass-card';
import './chat-onboarding-section.css';

export function ChatOnboardingSection({
  api,
  entityType = 'chat',
  isFetching,
  isRefreshBlocked,
  onRefresh,
}: {
  api: ApiTransport;
  entityType?: ManagedEntityType;
  isFetching: boolean;
  isRefreshBlocked: boolean;
  onRefresh: () => void;
}) {
  const diagnosticsQuery = useQuery({
    queryKey: queryKeys.managedEntityOnboardingDiagnostics(entityType),
    queryFn: ({ signal }) => getManagedEntityOnboardingDiagnostics(api, entityType, { signal }),
    staleTime: 15_000,
    gcTime: 60_000,
  });
  const diagnostics = diagnosticsQuery.data ?? null;
  const entityLabel = entityType === 'channel' ? 'канал' : 'чат';
  const entityGenitive = entityType === 'channel' ? 'канала' : 'чата';
  const entityPlural = entityType === 'channel' ? 'каналы' : 'чаты';
  const heading = entityType === 'channel' ? 'Каналы не найдены' : 'Нет доступных чатов';
  const lastHandshakeText = buildLastHandshakeText(diagnostics, entityLabel);
  const recentSignalText = buildRecentSignalText(diagnostics, entityLabel);

  return (
    <section className="chats-onboarding" aria-label={`Как подключить бота в MAX к ${entityLabel}у`}>
      <GlassCard className="chats-onboarding__hero" elevated>
        <div className="chats-onboarding__hero-top">
          <span className="chip chats-onboarding__badge">3 шага • 1 минута</span>
        </div>
        <div className="chats-onboarding__hero-text">
          <h1>{heading}</h1>
          <p>
            Добавьте бота, выдайте ему права администратора и нажмите «Проверить подключение» в
            сообщении бота. После успешной проверки {entityLabel} появится здесь автоматически.
          </p>
        </div>
      </GlassCard>

      {lastHandshakeText || recentSignalText ? (
        <GlassCard className="onboarding-diagnostics" elevated>
          <span className="onboarding-diagnostics__kicker">Последняя проверка</span>
          <strong>{lastHandshakeText ?? recentSignalText}</strong>
          {lastHandshakeText && recentSignalText ? <span>{recentSignalText}</span> : null}
        </GlassCard>
      ) : null}

      <GlassCard
        className="onboarding-step-card stagger-in"
        style={{ animationDelay: '40ms' }}
        elevated
      >
        <div className="onboarding-step-card__content">
          <h2>1. Добавьте бота</h2>
          <ul>
            <li>Откройте нужный {entityLabel} в MAX.</li>
            <li>Нажмите название {entityGenitive} → «Добавить участников».</li>
            <li>Найдите бота и добавьте его.</li>
          </ul>
        </div>
        <figure className="onboarding-step-card__media">
          <img
            src={addBotToChatImage}
            alt={`Добавление бота в участники ${entityGenitive} в MAX.`}
            loading="lazy"
          />
          <figcaption>Экран добавления участников в MAX.</figcaption>
        </figure>
      </GlassCard>

      <GlassCard
        className="onboarding-step-card stagger-in"
        style={{ animationDelay: '80ms' }}
        elevated
      >
        <div className="onboarding-step-card__content">
          <h2>2. Назначьте бота администратором</h2>
          <ul>
            <li>Откройте настройки {entityGenitive} → «Права администратора».</li>
            <li>Выберите бота и включите нужные права.</li>
            <li>Минимально для модерации: «Читать сообщения» и «Удалять сообщения».</li>
          </ul>
        </div>
        <figure className="onboarding-step-card__media">
          <img
            src={grantBotAdminRightsImage}
            alt={`Назначение бота администратором в настройках прав ${entityGenitive} MAX.`}
            loading="lazy"
          />
          <figcaption>Экран прав администратора для бота.</figcaption>
        </figure>
      </GlassCard>

      <GlassCard
        className="onboarding-step-card onboarding-step-card--command stagger-in"
        style={{ animationDelay: '120ms' }}
        elevated
      >
        <div className="onboarding-step-card__content">
          <h2>3. Подтвердите подключение</h2>
          <ul>
            <li>Нажмите «Проверить подключение» в сообщении бота.</li>
            <li>Если сообщения нет, отправьте в {entityLabel} слово Старт.</li>
            <li>Подтверждение доступно администратору или владельцу.</li>
            <li>После успешной проверки {entityLabel} появится в списке.</li>
          </ul>
        </div>
        <div className="onboarding-command-preview" aria-hidden>
          <span>Проверить подключение</span>
        </div>
      </GlassCard>

      <button
        type="button"
        className="button button--accent onboarding-refresh"
        onClick={onRefresh}
        disabled={isFetching || isRefreshBlocked}
      >
        {isFetching ? 'Обновляем...' : `Проверить ${entityPlural}`}
      </button>
    </section>
  );
}

function buildLastHandshakeText(
  diagnostics: ManagedEntityOnboardingDiagnostics | null | undefined,
  entityLabel: string,
): string | null {
  const last = diagnostics?.lastHandshake;
  if (!last) {
    return null;
  }

  if (last.status === 'connected' || last.status === 'already_connected') {
    return `${capitalize(entityLabel)} подключен, обновляем список.`;
  }
  if (last.status === 'bot_denied') {
    return 'Боту не хватает прав администратора.';
  }
  if (last.status === 'user_denied') {
    return 'Подтвердить подключение может администратор или владелец.';
  }
  if (last.status === 'bootstrapped_without_user') {
    return `Бот видит ${entityLabel}, осталось подтвердить доступ из mini app.`;
  }
  if (last.status === 'rate_limited') {
    return 'Проверка уже запущена, подождите пару минут.';
  }
  if (last.status === 'failed') {
    return 'MAX не ответил на проверку, попробуйте еще раз.';
  }

  return null;
}

function buildRecentSignalText(
  diagnostics: ManagedEntityOnboardingDiagnostics | null | undefined,
  entityLabel: string,
): string | null {
  const signal = diagnostics?.recentSignals[0];
  if (!signal) {
    return null;
  }

  if (signal.type === 'recent_activity') {
    return `Видим активность в MAX, нажмите «Проверить подключение» в сообщении бота.`;
  }
  if (signal.type === 'access_edge') {
    return signal.status === 'granted'
      ? `Доступ найден, обновите ${entityLabel}.`
      : `Доступ пока не подтвержден: ${formatSignalStatus(signal.status)}.`;
  }

  return null;
}

function formatSignalStatus(status: string): string {
  if (status === 'bot_denied') {
    return 'нет прав у бота';
  }
  if (status === 'user_denied') {
    return 'нет прав у пользователя';
  }
  return status.replace(/_/gu, ' ');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
