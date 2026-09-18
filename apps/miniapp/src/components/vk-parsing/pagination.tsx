import type { VkParsingFeedPagination } from '@maxim/contracts';
import { VK_PARSING_PAGE_SIZE } from './types';
import { NavArrowLeft, NavArrowRight } from 'iconoir-react';

type PaginationProps = {
  pagination: VkParsingFeedPagination | null | undefined;
  postsLength: number;
  pageOffset: number;
  isFetching: boolean;
  onPageOffsetChange: (offset: number) => void;
};

export function Pagination({
  pagination,
  postsLength,
  pageOffset,
  isFetching,
  onPageOffsetChange,
}: PaginationProps) {
  if (!pagination || (!pagination.hasMore && pagination.offset === 0)) {
    return null;
  }

  return (
    <div className="vk-parsing-pagination">
      <button
        type="button"
        className="button button--ghost"
        aria-label="Предыдущая страница"
        title="Предыдущая страница"
        disabled={pagination.offset === 0 || isFetching}
        onClick={() => onPageOffsetChange(Math.max(0, pageOffset - VK_PARSING_PAGE_SIZE))}
      >
        <NavArrowLeft aria-hidden />
      </button>
      <span>
        {pagination.total === 0 ? 0 : pagination.offset + 1}-
        {Math.min(pagination.total, pagination.offset + postsLength)} из {pagination.total}
      </span>
      <button
        type="button"
        className="button button--ghost"
        aria-label="Следующая страница"
        title="Следующая страница"
        disabled={!pagination.hasMore || isFetching}
        onClick={() => onPageOffsetChange(pagination.nextOffset ?? pageOffset)}
      >
        <NavArrowRight aria-hidden />
      </button>
    </div>
  );
}
