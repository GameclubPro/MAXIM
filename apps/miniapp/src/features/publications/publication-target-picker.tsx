import { MAX_PUBLICATION_TARGETS } from '@maxim/contracts/publication';
import { Check, NavArrowDown, Search, Xmark } from 'iconoir-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { cn } from '../../lib/cn';
import {
  getPublicationTargetKey,
  matchesPublicationSearch,
  type PublicationEntityFilter,
  type PublicationTarget,
} from './publication-model';

type PublicationTargetPickerProps = {
  choices: PublicationTarget[];
  value: PublicationTarget[];
  disabled?: boolean;
  error?: string | null;
  maxTargets?: number;
  onChange: (targets: PublicationTarget[]) => void;
  onLimitReached?: () => void;
};

const FILTERS: Array<{ value: PublicationEntityFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'chat', label: 'Чаты' },
  { value: 'channel', label: 'Каналы' },
];

export function PublicationTargetPicker({
  choices,
  value,
  disabled = false,
  error = null,
  maxTargets = MAX_PUBLICATION_TARGETS,
  onChange,
  onLimitReached,
}: PublicationTargetPickerProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PublicationEntityFilter>('all');
  const [expanded, setExpanded] = useState(() => value.length === 0);
  const editorId = useId();
  const errorId = useId();
  const selectedKeys = useMemo(
    () => new Set(value.map((target) => getPublicationTargetKey(target))),
    [value],
  );
  const visibleChoices = useMemo(
    () =>
      choices.filter(
        (choice) =>
          (filter === 'all' || choice.entityType === filter) &&
          matchesPublicationSearch([choice.title], query),
      ),
    [choices, filter, query],
  );
  const collapsedSelectedSummary =
    value.length === 0
      ? 'Выберите получателей'
      : value.length === 1
        ? (value[0]?.title ?? '1 получатель')
        : `Выбрано: ${value.length}`;
  const summaryTitle = expanded ? 'Получатели' : collapsedSelectedSummary;
  const summaryMeta =
    value.length === 0
      ? expanded
        ? 'Выберите чаты и каналы'
        : 'Чаты и каналы'
      : expanded
        ? `Выбрано: ${value.length}`
        : value.length === 1
          ? value[0]?.entityType === 'channel'
            ? 'Канал'
            : 'Чат'
          : 'Чаты и каналы';
  const hasHiddenSelection = value.some(
    (target) =>
      !visibleChoices.some(
        (choice) => getPublicationTargetKey(choice) === getPublicationTargetKey(target),
      ),
  );
  const shouldShowSelectedChips = value.length > 1 || hasHiddenSelection;

  useEffect(() => {
    if (error) {
      setExpanded(true);
    }
  }, [error]);

  function toggleTarget(target: PublicationTarget) {
    const key = getPublicationTargetKey(target);
    if (!selectedKeys.has(key) && value.length >= maxTargets) {
      onLimitReached?.();
      return;
    }
    onChange(
      selectedKeys.has(key)
        ? value.filter((item) => getPublicationTargetKey(item) !== key)
        : [...value, target],
    );
  }

  return (
    <div className={cn('publication-target-picker', error && 'has-error')}>
      <button
        type="button"
        className={cn(
          'publication-target-picker__summary',
          value.length === 0 && 'is-empty',
          expanded && 'is-expanded',
        )}
        onClick={() => setExpanded((current) => !current)}
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-describedby={error ? errorId : undefined}
      >
        <span>
          <strong>{summaryTitle}</strong>
          <small>{summaryMeta}</small>
        </span>
        <span className="publication-target-picker__summary-action">
          {expanded ? 'Свернуть' : 'Изменить'}
        </span>
        <NavArrowDown aria-hidden />
      </button>

      {expanded ? (
        <div
          id={editorId}
          className="publication-target-picker__editor"
          role="region"
          aria-label="Выбор получателей"
        >
          {shouldShowSelectedChips ? (
            <div
              className="publication-target-picker__selected"
              role="list"
              aria-label="Выбранные получатели"
            >
              {value.map((target) => (
                <span
                  key={getPublicationTargetKey(target)}
                  className="publication-target-chip"
                  role="listitem"
                >
                  <span>{target.title}</span>
                  <button
                    type="button"
                    onClick={() => toggleTarget(target)}
                    disabled={disabled}
                    aria-label={`Убрать ${target.title}`}
                  >
                    <Xmark aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <label className="publication-search">
            <Search aria-hidden />
            <input
              type="search"
              value={query}
              placeholder="Найти чат или канал"
              aria-label="Найти получателя"
              onChange={(event) => setQuery(event.currentTarget.value)}
              disabled={disabled}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Очистить поиск"
                disabled={disabled}
              >
                <Xmark aria-hidden />
              </button>
            ) : null}
          </label>

          <div
            className="publication-target-picker__filters"
            role="group"
            aria-label="Тип получателя"
          >
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                className={cn(filter === item.value && 'is-active')}
                onClick={() => setFilter(item.value)}
                disabled={disabled}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="publication-target-picker__list" role="group" aria-label="Получатели">
            {visibleChoices.length > 0 ? (
              visibleChoices.map((choice) => {
                const selected = selectedKeys.has(getPublicationTargetKey(choice));
                return (
                  <button
                    key={getPublicationTargetKey(choice)}
                    type="button"
                    className={cn('publication-target-row', selected && 'is-selected')}
                    aria-pressed={selected}
                    aria-label={`${selected ? 'Убрать' : 'Выбрать'} ${choice.title}, ${
                      choice.entityType === 'channel' ? 'канал' : 'чат'
                    }`}
                    onClick={() => toggleTarget(choice)}
                    disabled={disabled}
                  >
                    <EntityAvatar
                      title={choice.title}
                      entityType={choice.entityType}
                      avatarUrl={choice.avatarUrl}
                      className="publication-target-row__avatar"
                    />
                    <span className="publication-target-row__copy">
                      <strong>{choice.title}</strong>
                      <small>{choice.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
                    </span>
                    <span className="publication-target-row__check" aria-hidden>
                      {selected ? <Check /> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <span className="publication-target-picker__empty" role="status">
                Ничего не найдено
              </span>
            )}
          </div>
        </div>
      ) : null}

      {error ? (
        <p id={errorId} className="publication-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
