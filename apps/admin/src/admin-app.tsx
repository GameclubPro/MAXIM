import {
  Calendar,
  Check,
  CheckCircle,
  Clock,
  Eye,
  Filter,
  Lock,
  NavArrowRight,
  Refresh,
  Search,
  SettingsProfiles,
  ShieldCheck,
  WarningTriangle,
  Xmark,
  XmarkCircle,
} from 'iconoir-react';
import { useMemo, useState } from 'react';

type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';
type QueueStatus = 'review' | 'approved' | 'rejected' | 'blocked';
type QueueSource = 'manual' | 'scheduled' | 'vk';

type ModerationItem = {
  id: string;
  title: string;
  source: QueueSource;
  status: QueueStatus;
  risk: RiskLevel;
  entity: string;
  author: string;
  scheduledAt: string;
  text: string;
  domains: string[];
  reasons: string[];
  checks: Array<{ label: string; state: 'passed' | 'warning' | 'blocked' }>;
};

const accessCode = import.meta.env.VITE_ADMIN_ACCESS_CODE || 'maxim-local';

const items: ModerationItem[] = [
  {
    id: 'br-1048',
    title: 'Публикация с внешней ссылкой',
    source: 'scheduled',
    status: 'review',
    risk: 'medium',
    entity: 'Канал администраторов',
    author: 'Мария',
    scheduledAt: 'Сегодня, 18:20',
    text: 'Новая инструкция для администраторов: порядок проверки приветствий, ссылок и кнопок перед публикацией.',
    domains: ['major-maksimov.ru'],
    reasons: ['Внешняя ссылка требует подтверждения', 'Публикация запланирована в несколько целей'],
    checks: [
      { label: 'Запрещенные категории не найдены', state: 'passed' },
      { label: 'Ссылки извлечены и проверены', state: 'warning' },
      { label: 'Принудительного добавления пользователей нет', state: 'passed' },
    ],
  },
  {
    id: 'br-1051',
    title: 'Короткий автопост без ссылок',
    source: 'manual',
    status: 'approved',
    risk: 'low',
    entity: 'Чат модераторов',
    author: 'Алексей',
    scheduledAt: 'Опубликовано 14:05',
    text: 'Плановая памятка для администраторов: проверьте закреп и правила чата.',
    domains: [],
    reasons: ['Низкий риск', 'Публикация разрешена автоматически'],
    checks: [
      { label: 'Текст прошел фильтр', state: 'passed' },
      { label: 'Медиа отсутствуют', state: 'passed' },
      { label: 'Целевая аудитория ограничена управляемым чатом', state: 'passed' },
    ],
  },
  {
    id: 'br-1053',
    title: 'Пост из внешнего источника',
    source: 'vk',
    status: 'blocked',
    risk: 'blocked',
    entity: 'Городской канал',
    author: 'VK parser',
    scheduledAt: 'Пропущено 16:00',
    text: 'Материал из источника содержит несколько контактов, ссылку на оплату и коммерческие маркеры.',
    domains: ['short.link', 'pay.example'],
    reasons: [
      'Подозрительный короткий домен',
      'Финансовые маркеры в тексте',
      'Нужна ручная переработка',
    ],
    checks: [
      { label: 'Ссылки высокого риска', state: 'blocked' },
      { label: 'Коммерческие маркеры найдены', state: 'blocked' },
      { label: 'В чат ничего не отправлено', state: 'passed' },
    ],
  },
];

const policySteps = [
  {
    title: 'Тихая предварительная проверка',
    body: 'Контент проверяется на сервере до отправки в MAX. Если риск низкий, публикация проходит без дополнительного шага для администратора.',
  },
  {
    title: 'Очередь только для ответственных',
    body: 'Спорные материалы остаются в закрытой панели. В чатах не появляются служебные сообщения, отметки проверки или уведомления о задержке.',
  },
  {
    title: 'Точный журнал решений',
    body: 'Для каждой проверки фиксируются автор, цель, домены, вердикт, версия политики и хэш контента. Это можно показать поддержке MAX.',
  },
  {
    title: 'Без принудительного добавления',
    body: 'Бот публикует только в управляемые чаты и каналы, куда его добавил администратор. Пользователей он не приглашает и не добавляет.',
  },
];

export function AdminApp() {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem('maxim-admin') === '1');
  const [code, setCode] = useState('');
  const [filter, setFilter] = useState<'all' | QueueStatus>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? '');

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesStatus = filter === 'all' || item.status === filter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [item.title, item.entity, item.author, item.text, ...item.domains]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);

      return matchesStatus && matchesQuery;
    });
  }, [filter, query]);

  const selectedItem = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];

  function unlock() {
    if (code.trim() === accessCode) {
      sessionStorage.setItem('maxim-admin', '1');
      setUnlocked(true);
    }
  }

  if (!unlocked) {
    return (
      <main className="auth-shell">
        <section className="auth-panel" aria-labelledby="auth-title">
          <div className="auth-panel__mark">
            <Lock width={24} height={24} />
          </div>
          <p className="eyebrow">MAXIM Safety Desk</p>
          <h1 id="auth-title">Закрытая проверка автопостинга</h1>
          <p className="auth-panel__copy">
            Панель предназначена для владельца проекта и команды модерации. Проверка проходит до
            публикации, поэтому обычные пользователи не видят служебных статусов.
          </p>
          <label className="auth-field">
            <span>Код доступа</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  unlock();
                }
              }}
              type="password"
              autoComplete="current-password"
              placeholder="Введите код"
            />
          </label>
          <button className="primary-action" type="button" onClick={unlock}>
            <ShieldCheck width={18} height={18} />
            Открыть панель
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <aside className="sidebar" aria-label="Навигация">
        <div className="brand">
          <div className="brand__mark">
            <ShieldCheck width={24} height={24} />
          </div>
          <div>
            <strong>Safety Desk</strong>
            <span>закрытая панель</span>
          </div>
        </div>
        <nav className="nav-list">
          <a className="nav-list__item is-active" href="#queue">
            <Filter width={18} height={18} />
            Очередь проверки
          </a>
          <a className="nav-list__item" href="#policy">
            <SettingsProfiles width={18} height={18} />
            Политика
          </a>
          <a className="nav-list__item" href="#audit">
            <Clock width={18} height={18} />
            Журнал
          </a>
        </nav>
        <div className="sidebar__note">
          <b>Правило UX</b>
          <span>Если материал задержан, в MAX ничего не публикуется до решения.</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">pre-publication safety</p>
            <h1>Модерация автопостинга</h1>
          </div>
          <div className="topbar__actions">
            <button className="ghost-action" type="button">
              <Refresh width={18} height={18} />
              Обновить
            </button>
            <button className="primary-action compact" type="button">
              <Check width={18} height={18} />
              Экспорт для MAX
            </button>
          </div>
        </header>

        <section className="metrics" aria-label="Сводка">
          <Metric label="Ожидают" value="1" tone="warning" />
          <Metric label="Одобрено сегодня" value="18" tone="success" />
          <Metric label="Заблокировано" value="1" tone="danger" />
          <Metric label="Служебных постов в чатах" value="0" tone="neutral" />
        </section>

        <section className="queue-layout" id="queue">
          <div className="queue-panel">
            <div className="queue-toolbar">
              <label className="search-field">
                <Search width={17} height={17} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Поиск по тексту, домену, чату"
                />
              </label>
              <div className="segmented" aria-label="Фильтр статуса">
                {[
                  ['all', 'Все'],
                  ['review', 'Проверка'],
                  ['approved', 'Одобрено'],
                  ['blocked', 'Блок'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={filter === value ? 'is-active' : ''}
                    type="button"
                    onClick={() => setFilter(value as 'all' | QueueStatus)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="queue-list">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  className={`queue-item ${selectedItem?.id === item.id ? 'is-selected' : ''}`}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className={`risk-dot is-${item.risk}`} />
                  <span className="queue-item__body">
                    <span className="queue-item__title">{item.title}</span>
                    <span className="queue-item__meta">
                      {sourceLabel(item.source)} · {item.entity}
                    </span>
                  </span>
                  <StatusBadge status={item.status} />
                  <NavArrowRight width={18} height={18} />
                </button>
              ))}
            </div>
          </div>

          {selectedItem ? <ReviewDetails item={selectedItem} /> : null}
        </section>

        <section className="policy-section" id="policy">
          <div className="section-heading">
            <p className="eyebrow">MAX compliance plan</p>
            <h2>План без давления на пользователей</h2>
          </div>
          <div className="policy-grid">
            {policySteps.map((step) => (
              <article className="policy-card" key={step.title}>
                <CheckCircle width={20} height={20} />
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  return (
    <article className={`metric-card is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ReviewDetails({ item }: { item: ModerationItem }) {
  return (
    <article className="review-card" aria-label="Детали проверки">
      <header className="review-card__header">
        <div>
          <StatusBadge status={item.status} />
          <h2>{item.title}</h2>
        </div>
        <RiskBadge risk={item.risk} />
      </header>

      <div className="review-meta">
        <span>
          <Calendar width={16} height={16} />
          {item.scheduledAt}
        </span>
        <span>
          <Eye width={16} height={16} />
          {item.entity}
        </span>
      </div>

      <div className="content-preview">
        <p>{item.text}</p>
      </div>

      <section className="detail-block">
        <h3>Причины проверки</h3>
        <div className="reason-list">
          {item.reasons.map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>
      </section>

      <section className="detail-block">
        <h3>Проверки</h3>
        <div className="check-list">
          {item.checks.map((check) => (
            <div className={`check-row is-${check.state}`} key={check.label}>
              {check.state === 'blocked' ? (
                <XmarkCircle width={18} height={18} />
              ) : check.state === 'warning' ? (
                <WarningTriangle width={18} height={18} />
              ) : (
                <CheckCircle width={18} height={18} />
              )}
              <span>{check.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="detail-block">
        <h3>Домены</h3>
        <div className="domain-list">
          {item.domains.length > 0 ? (
            item.domains.map((domain) => <span key={domain}>{domain}</span>)
          ) : (
            <span>Нет внешних ссылок</span>
          )}
        </div>
      </section>

      <footer className="review-actions">
        <button className="secondary-action" type="button">
          <Xmark width={18} height={18} />
          Отклонить
        </button>
        <button className="ghost-action" type="button">
          <Refresh width={18} height={18} />
          Проверить снова
        </button>
        <button className="primary-action" type="button" disabled={item.status === 'blocked'}>
          <Check width={18} height={18} />
          Одобрить
        </button>
      </footer>
    </article>
  );
}

function StatusBadge({ status }: { status: QueueStatus }) {
  const labels: Record<QueueStatus, string> = {
    review: 'На проверке',
    approved: 'Одобрено',
    rejected: 'Отклонено',
    blocked: 'Блок',
  };

  return <span className={`status-badge is-${status}`}>{labels[status]}</span>;
}

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const labels: Record<RiskLevel, string> = {
    low: 'Низкий риск',
    medium: 'Средний риск',
    high: 'Высокий риск',
    blocked: 'Заблокировано',
  };

  return <span className={`risk-badge is-${risk}`}>{labels[risk]}</span>;
}

function sourceLabel(source: QueueSource) {
  if (source === 'vk') {
    return 'Внешний источник';
  }

  if (source === 'scheduled') {
    return 'Запланировано';
  }

  return 'Ручная публикация';
}
