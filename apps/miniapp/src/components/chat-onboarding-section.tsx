import type { ManagedEntityType } from '@maxim/contracts';
import { PlusCircleGlyph, RefreshGlyph } from './ui/compact-icons';
import { GlassCard } from './ui/glass-card';
import './chat-onboarding-section.css';
import './chat-onboarding-command.css';

export function ChatOnboardingSection({
  entityType = 'chat',
  isFetching,
  isRefreshBlocked,
  onConnect,
  onRefresh,
}: {
  entityType?: ManagedEntityType;
  isFetching: boolean;
  isRefreshBlocked: boolean;
  onConnect: (trigger: HTMLElement) => void;
  onRefresh: () => void;
}) {
  const entityLabel = entityType === 'channel' ? 'канал' : 'чат';
  const heading = entityType === 'channel' ? 'Подключите первый канал' : 'Подключите первый чат';

  return (
    <section
      className="chats-onboarding"
      aria-label={`Как подключить бота в MAX к ${entityLabel}у`}
    >
      <GlassCard className="chats-onboarding__hero" elevated>
        <div className="chats-onboarding__hero-text">
          <h1>{heading}</h1>
          <p>Добавьте бота администратором и перешлите ему сообщение.</p>
        </div>

        <div className="onboarding-actions">
          <button
            type="button"
            className="button button--accent onboarding-connect"
            aria-haspopup="dialog"
            aria-controls="home-sheet-connect"
            onClick={(event) => onConnect(event.currentTarget)}
          >
            <PlusCircleGlyph aria-hidden focusable="false" />
            Подключить чат или канал
          </button>
          <button
            type="button"
            className="button button--ghost onboarding-refresh"
            onClick={onRefresh}
            disabled={isFetching || isRefreshBlocked}
            aria-label={isFetching ? `Обновляем ${entityLabel}` : `Обновить ${entityLabel}`}
          >
            <RefreshGlyph aria-hidden focusable="false" />
            Обновить
          </button>
        </div>
      </GlassCard>
    </section>
  );
}
