import { useQuery } from '@tanstack/react-query';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import type { ManagedEntityOnboardingDiagnostics, ManagedEntityType } from '@maxim/contracts';
import { getManagedEntityOnboardingDiagnostics } from '../lib/api/onboarding-diagnostics-client';
import type { ApiTransport } from '../lib/api/transport';
import { queryKeys } from '../lib/query-keys';
import { GlassCard } from './ui/glass-card';
import './chat-onboarding-section.css';
import './chat-onboarding-command.css';

export function ChatOnboardingSection({
  api,
  entityType = 'chat',
  isFetching,
  isRefreshBlocked,
  refreshLabel,
  onRefresh,
}: {
  api: ApiTransport;
  entityType?: ManagedEntityType;
  isFetching: boolean;
  isRefreshBlocked: boolean;
  refreshLabel?: string;
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
    <section
      className="chats-onboarding"
      aria-label={`Как подключить бота в MAX к ${entityLabel}у`}
    >
      <GlassCard className="chats-onboarding__hero" elevated>
        <div className="chats-onboarding__hero-text">
          <h1>{heading}</h1>
          <p>Добавьте бота администратором и подтвердите подключение в MAX.</p>
        </div>

        {lastHandshakeText || recentSignalText ? (
          <div className="onboarding-diagnostics" role="status">
            <strong>{lastHandshakeText ?? recentSignalText}</strong>
            {lastHandshakeText && recentSignalText ? <span>{recentSignalText}</span> : null}
          </div>
        ) : null}

        <button
          type="button"
          className="button button--accent onboarding-refresh"
          onClick={onRefresh}
          disabled={isFetching || isRefreshBlocked}
        >
          {isFetching
            ? 'Обновляем...'
            : isRefreshBlocked && refreshLabel
              ? refreshLabel
              : `Проверить ${entityPlural}`}
        </button>

        <ol className="onboarding-steps">
          <li>
            <span>1</span>
            <div>
              <strong>Добавьте бота</strong>
              <small>Через список участников {entityGenitive}.</small>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Выдайте права</strong>
              <small>Боту нужны права администратора.</small>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Подтвердите доступ</strong>
              <small>Нажмите кнопку в сообщении бота.</small>
            </div>
          </li>
        </ol>

        <details className="onboarding-instructions">
          <summary>Показать инструкцию</summary>
          <div className="onboarding-instructions__body">
            <figure>
              <img
                src={addBotToChatImage}
                alt={`Добавление бота в участники ${entityGenitive} в MAX.`}
                loading="lazy"
              />
              <figcaption>
                Откройте {entityLabel}, нажмите его название и выберите «Добавить участников».
              </figcaption>
            </figure>
            <figure>
              <img
                src={grantBotAdminRightsImage}
                alt={`Назначение бота администратором в настройках прав ${entityGenitive} MAX.`}
                loading="lazy"
              />
              <figcaption>
                В правах администратора разрешите боту читать и удалять сообщения.
              </figcaption>
            </figure>
            <p>
              Затем нажмите «Проверить подключение» в сообщении бота. Если сообщения нет, отправьте
              слово «Старт».
            </p>
          </div>
        </details>
      </GlassCard>
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
