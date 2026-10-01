import { AppIcon } from './app-icon';
import type { AppIconName } from './app-icon-names';
import type { ReactElement } from 'react';
import { cn } from '../../lib/cn';
import './settings-section-toggle.css';
import './settings-section-icons.css';

export type SettingsSectionIconName =
  | 'links'
  | 'rules'
  | 'greeting'
  | 'warning'
  | 'ads'
  | 'keywords'
  | 'repeat'
  | 'shield'
  | 'phone'
  | 'subscription'
  | 'moon'
  | 'send'
  | 'commands'
  | 'storefront'
  | 'tools'
  | 'comments'
  | 'spark'
  | 'gift';

export type SettingsSectionTone = 'sky' | 'mint' | 'amber' | 'rose' | 'ink';

const SETTINGS_SECTION_SEARCH_ALIASES: Record<string, string> = {
  Автопостинг: 'публикации расписание посты',
  Команды: 'администратор команды бота',
  'Коммерческая реклама': 'реклама продажи услуги ссылки',
  'Интернет-витрина': 'караван витрина продавец магазин кнопка доллар',
  'Рекламная площадка': 'Связка реклама взаимопиар биржа размещение',
  Комментарии: 'обсуждение посты модерация',
  'Комментарии в приложении': 'обсуждение посты модерация кастомные',
  'Мат и оскорбления': 'мат ругань токсичность фильтр',
  'Ночной режим': 'тишина расписание закрыть чат ночь',
  Ограничения: 'антиспам спамеры лимит сообщений длина фото видео стикеры телефон',
  Опросы: 'голосование голоса варианты',
  'Действие под публикацией': 'подпись кнопка ссылка адрес реклама посты публикации канал',
  Антидубль: 'повторы дубликаты одинаковые сообщения фото',
  Подписка: 'обязательная подписка каналы доступ',
  Правила: 'пост описание чат',
  Предложения: 'предложить пост пользовательские публикации',
  Приветствие: 'новички вход вступление',
  Розыгрыши: 'конкурс призы победители участники',
  Ссылки: 'домены белый список срок действия блокировка',
  'Сообщения и боты': 'удаление сервисные сообщения боты',
  'Стиль речи': 'тон ответы бота сообщения',
  'Стоп-слова': 'слова фразы фраза сайты сайт домены запрет черный список',
  'Система жалоб': 'жалобы жалоба report участники порог голоса журнал',
};

type SettingsSectionToggleProps = {
  title: string;
  summary?: string;
  status?: string;
  icon: SettingsSectionIconName | ReactElement;
  tone: SettingsSectionTone;
  open: boolean;
  controls: string;
  onClick: () => void;
};

const SETTINGS_SECTION_ICONS = {
  links: 'Link',
  rules: 'Book',
  greeting: 'UserPlus',
  warning: 'WarningTriangle',
  ads: 'Megaphone',
  keywords: 'Hashtag',
  repeat: 'Copy',
  shield: 'ShieldCheck',
  phone: 'Phone',
  subscription: 'CheckSquare',
  moon: 'MoonSat',
  send: 'SendDiagonal',
  commands: 'Terminal',
  storefront: 'Shop',
  tools: 'Wrench',
  comments: 'ChatLines',
  spark: 'Sparks',
  gift: 'Gift',
} as const satisfies Record<SettingsSectionIconName, AppIconName>;

export function SettingsSectionIcon({ name }: { name: SettingsSectionIconName }) {
  return <AppIcon icon={SETTINGS_SECTION_ICONS[name]} />;
}

export function SettingsSectionToggle({
  title,
  summary,
  status,
  icon,
  tone,
  open,
  controls,
  onClick,
}: SettingsSectionToggleProps) {
  const trimmedSummary = summary?.trim() ?? '';
  const trimmedStatus = status?.trim() ?? '';
  const summaryId = `${controls}-entry-summary`;
  const statusId = `${controls}-entry-status`;
  const descriptionIds = [trimmedSummary ? summaryId : '', trimmedStatus ? statusId : '']
    .filter(Boolean)
    .join(' ');
  const searchText = [title, trimmedSummary, trimmedStatus, SETTINGS_SECTION_SEARCH_ALIASES[title]]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className="settings-section__toggle is-stateless"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={title}
      aria-describedby={descriptionIds || undefined}
      data-settings-search={searchText}
      onClick={onClick}
    >
      <span className={cn('settings-section__icon-badge', `is-${tone}`)} aria-hidden>
        {typeof icon === 'string' ? <SettingsSectionIcon name={icon} /> : icon}
      </span>

      <span className="settings-section__toggle-main">
        <span className="settings-section__title">{title}</span>
        {trimmedSummary ? (
          <span id={summaryId} className="settings-section__summary">
            {trimmedSummary}
          </span>
        ) : null}
      </span>

      {trimmedStatus ? (
        <span id={statusId} className={cn('settings-section__status-chip', `is-${tone}`)}>
          {trimmedStatus}
        </span>
      ) : null}

      <span className="settings-section__chevron" aria-hidden>
        <AppIcon icon="NavArrowRight" className="settings-section__chevron-icon" />
      </span>
    </button>
  );
}
