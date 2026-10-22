import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import { AppIcon } from '../../components/ui/app-icon';
import { useHomeEntityFavorites } from '../../lib/home-entity-favorites-context';
import { HOME_ENTITY_FAVORITE_TYPES } from '../../lib/home-entity-favorites';
import { useNativeBackHandler } from '../../lib/native-back';
import { formatNetworkEntityCount, networkCategoryIcons } from './network-identity';
import './network-workspace.css';

export type NetworkWorkspaceTab = 'overview' | 'settings' | 'communities';
export function NetworkWorkspaceTabs({
  value,
  onChange,
  settingsDisabled = false,
}: {
  value: NetworkWorkspaceTab;
  onChange: (tab: NetworkWorkspaceTab) => void;
  settingsDisabled?: boolean;
}) {
  return (
    <nav className="network-workspace-tabs" aria-label="Раздел сетки">
      {(
        [
          ['overview', 'Статистика'],
          ['settings', 'Настройки'],
          ['communities', 'Состав'],
        ] as const
      ).map(([tab, label]) => (
        <button
          type="button"
          key={tab}
          aria-current={value === tab ? 'page' : undefined}
          disabled={tab === 'settings' && settingsDisabled}
          onClick={() => onChange(tab)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
export function NetworkWorkspaceHeader({
  entityType,
  favoriteType,
  count,
  title,
  onBack,
  onPick,
  backLabel = 'Все сетки',
}: {
  entityType: ManagedEntityType;
  favoriteType?: ManagedEntityFavoriteType;
  count?: number;
  title: string;
  onBack: () => void;
  onPick: (type: ManagedEntityType, category: ManagedEntityFavoriteType) => void;
  backLabel?: string;
}) {
  const navigate = useNavigate();
  const { snapshot, actions } = useHomeEntityFavorites();
  const [rename, setRename] = useState<{
    value: string;
    base: typeof snapshot.labels.overrides;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useNativeBackHandler(
    () => {
      if (!busy) setRename(null);
      return true;
    },
    { enabled: rename !== null, priority: 150 },
  );
  useNativeBackHandler(
    () => {
      setMenuOpen(false);
      return true;
    },
    { enabled: menuOpen, priority: 140 },
  );
  const label = favoriteType ? snapshot.labels.resolved[favoriteType] : title;
  const saveName = async () => {
    if (!rename || !favoriteType || busy || !rename.value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await actions.saveLabels({
        baseLabels: rename.base,
        draftLabels: { ...rename.base, [favoriteType]: rename.value.trim() },
      });
      setRename(null);
    } catch {
      setError('Название не сохранено. Проверьте актуальное имя и повторите.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="network-workspace-identity">
      <header className="network-workspace-heading">
        <button
          type="button"
          className="network-workspace-back"
          aria-label={backLabel}
          onClick={onBack}
        >
          <AppIcon icon="NavArrowLeft" />
        </button>
        <span className="network-workspace-icon">
          <AppIcon icon={favoriteType ? networkCategoryIcons[favoriteType] : 'Group'} />
        </span>
        <div>
          <h1>{label}</h1>
          <p>
            {count === undefined
              ? entityType === 'chat'
                ? 'Сетка чатов'
                : 'Сетка каналов'
              : formatNetworkEntityCount(count, entityType)}
          </p>
        </div>
        {favoriteType ? (
          <details
            className="network-workspace-menu"
            open={menuOpen}
            onToggle={(event) => setMenuOpen(event.currentTarget.open)}
          >
            <summary aria-label="Выбрать сетку и действия">
              <AppIcon icon="NavArrowRight" />
            </summary>
            <div>
              <label>
                Тип{' '}
                <select
                  aria-label="Тип сетки"
                  value={entityType}
                  onChange={(event) =>
                    onPick(event.target.value as ManagedEntityType, favoriteType)
                  }
                >
                  <option value="chat">Чаты</option>
                  <option value="channel">Каналы</option>
                </select>
              </label>
              <label>
                Сетка{' '}
                <select
                  aria-label="Переключить сетку"
                  value={favoriteType}
                  onChange={(event) =>
                    onPick(entityType, event.target.value as ManagedEntityFavoriteType)
                  }
                >
                  {HOME_ENTITY_FAVORITE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {snapshot.labels.resolved[type]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setRename({ value: label, base: { ...snapshot.labels.overrides } });
                }}
              >
                Переименовать
              </button>
              <button
                type="button"
                onClick={() => navigate(`/networks?type=${entityType}&history=1`)}
              >
                Последние изменения
              </button>
            </div>
          </details>
        ) : null}
      </header>
      {rename ? (
        <form
          className="network-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <label>
            Название сетки
            <input
              aria-label="Название сетки"
              maxLength={32}
              disabled={busy}
              value={rename.value}
              onChange={(event) => setRename({ ...rename, value: event.target.value })}
            />
          </label>
          <p>Общее название избранного для чатов и каналов на главной.</p>
          {error ? <p role="alert">{error}</p> : null}
          <div>
            <button type="submit" disabled={busy || !rename.value.trim()}>
              {busy ? 'Сохраняем…' : 'Сохранить название'}
            </button>
            <button type="button" disabled={busy} onClick={() => setRename(null)}>
              Отмена
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
