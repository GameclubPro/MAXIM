import { Search } from 'iconoir-react';
import { useState } from 'react';
import { useSettingsOverviewFilter } from '../../lib/settings-overview-filter';
import { XmarkGlyph } from './compact-icons';
import './settings-overview-search.css';

type SettingsOverviewSearchProps = {
  containerId: string;
  entrySelector: string;
  groupSelector?: string;
};

export function SettingsOverviewSearch({
  containerId,
  entrySelector,
  groupSelector,
}: SettingsOverviewSearchProps) {
  const [value, setValue] = useState('');
  const matchCount = useSettingsOverviewFilter({
    query: value,
    containerId,
    entrySelector,
    groupSelector,
  });
  const hasQuery = value.trim().length > 0;

  return (
    <div className="settings-overview-search-wrap">
      <label className="settings-overview-search">
        <Search aria-hidden focusable="false" />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Найти настройку"
          aria-label="Найти настройку"
          autoComplete="off"
        />
        {hasQuery ? (
          <button type="button" onClick={() => setValue('')} aria-label="Очистить поиск">
            <XmarkGlyph aria-hidden />
          </button>
        ) : null}
      </label>

      {hasQuery && matchCount === 0 ? (
        <div className="settings-overview-search__empty" role="status">
          <span>Ничего не найдено</span>
          <button type="button" onClick={() => setValue('')}>
            Сбросить поиск
          </button>
        </div>
      ) : null}
    </div>
  );
}
