import type { VkParsingPostFilterStatus } from '@maxim/contracts';
import { cn } from '../../lib/cn';
import { VK_PARSING_STATUS_FILTERS } from './types';

type StatusFilterBarProps = {
  statusFilter: VkParsingPostFilterStatus;
  onSelectStatusFilter: (value: VkParsingPostFilterStatus) => void;
};

export function StatusFilterBar({ statusFilter, onSelectStatusFilter }: StatusFilterBarProps) {
  return (
    <div className="vk-parsing-filter-bar" aria-label="Фильтр VK-постов">
      {VK_PARSING_STATUS_FILTERS.map((item) => (
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
    </div>
  );
}
