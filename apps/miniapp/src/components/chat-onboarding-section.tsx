import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { GlassCard } from './ui/glass-card';
import './chat-onboarding-section.css';

export function ChatOnboardingSection({
  isFetching,
  isRefreshBlocked,
  onRefresh,
}: {
  isFetching: boolean;
  isRefreshBlocked: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="chats-onboarding" aria-label="Как подключить бота в MAX к групповому чату">
      <GlassCard className="chats-onboarding__hero" elevated>
        <div className="chats-onboarding__hero-top">
          <span className="chip chats-onboarding__badge">2 шага • 1 минута</span>
        </div>
        <div className="chats-onboarding__hero-text">
          <h1>Нет доступных чатов</h1>
          <p>
            Чтобы увидеть чат в приложении, добавьте чат-бота в чат и выдайте ему права
            администратора. После этого откройте mini app из нужного чата и дождитесь проверки.
          </p>
        </div>
      </GlassCard>

      <GlassCard
        className="onboarding-step-card stagger-in"
        style={{ animationDelay: '40ms' }}
        elevated
      >
        <div className="onboarding-step-card__content">
          <h2>1. Добавьте бота в чат</h2>
          <ul>
            <li>Откройте нужный групповой чат в MAX.</li>
            <li>Нажмите название чата → «Добавить участников».</li>
            <li>Найдите бота и добавьте его в чат.</li>
          </ul>
        </div>
        <figure className="onboarding-step-card__media">
          <img
            src={addBotToChatImage}
            alt="Добавление бота в участники группового чата в MAX."
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
            <li>Откройте профиль чата → «Права администратора».</li>
            <li>Выберите бота и включите нужные права.</li>
            <li>Минимально для модерации: «Читать сообщения» и «Удалять сообщения».</li>
          </ul>
        </div>
        <figure className="onboarding-step-card__media">
          <img
            src={grantBotAdminRightsImage}
            alt="Назначение бота администратором в настройках прав чата MAX."
            loading="lazy"
          />
          <figcaption>Экран прав администратора для бота.</figcaption>
        </figure>
      </GlassCard>

      <button
        type="button"
        className="button button--accent onboarding-refresh"
        onClick={onRefresh}
        disabled={isFetching || isRefreshBlocked}
      >
        {isFetching ? 'Обновляем...' : 'Я добавил бота, обновить'}
      </button>
    </section>
  );
}
