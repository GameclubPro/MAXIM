import type { VkParsingPostFilterStatus } from '@maxim/contracts';
import { NavArrowDown } from 'iconoir-react';
import { cn } from '../../lib/cn';
import { VK_PARSING_STATUS_FILTERS } from './types';

type StatusFilterBarProps = {
  statusFilter: VkParsingPostFilterStatus;
  onSelectStatusFilter: (value: VkParsingPostFilterStatus) => void;
};

export function StatusFilterBar({ statusFilter, onSelectStatusFilter }: StatusFilterBarProps) {
  const primaryFilters = VK_PARSING_STATUS_FILTERS.slice(0, 4);
  const secondaryFilters = VK_PARSING_STATUS_FILTERS.slice(4);
  const secondaryActive = secondaryFilters.some((item) => item.value === statusFilter);

  return (
    <div className="vk-parsing-filter-bar" aria-label="Фильтр VK-постов">
      {primaryFilters.map((item) => (
        <button
          key={item.value}
          type="button"
          className={cn('vk-parsing-filter-chip', statusFilter === item.value && 'is-active')}
          aria-pressed={statusFilter === item.value}
          onClick={() => onSelectStatusFilter(item.value)}
        >
          {item.label}
        </button>
      ))}
      <label className={cn('vk-parsing-filter-more', secondaryActive && 'is-active')}>
        <select
          value={secondaryActive ? statusFilter : ''}
          aria-label="Другие статусы"
          onChange={(event) =>
            onSelectStatusFilter(event.target.value as VkParsingPostFilterStatus)
          }
        >
          <option value="" disabled>
            Ещё
          </option>
          {secondaryFilters.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <NavArrowDown aria-hidden focusable="false" />
      </label>
    </div>
  );
}
