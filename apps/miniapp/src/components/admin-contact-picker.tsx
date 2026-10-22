import { useInfiniteQuery } from '@tanstack/react-query';
import { AppIcon } from './ui/app-icon';
import { useEffect, useState } from 'react';
import { buildAdminContactOptions } from '../lib/admin-contact-profile-url';
import type { ApiTransport } from '../lib/api/transport';
import { PersonAvatar } from './ui/person-avatar';
import { AdminContactPickerPanel } from './admin-contact-picker-panel';
import './admin-contact-toggle.css';

type AdminContactPickerProps = {
  api: ApiTransport;
  chatId: string;
  checked: boolean;
  url: string;
  onSelect: (url: string, name: string) => void;
  onClose: () => void;
};

export function AdminContactPicker({
  api,
  chatId,
  checked,
  url,
  onSelect,
  onClose: close,
}: AdminContactPickerProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const admins = useInfiniteQuery({
    queryKey: ['admin-contact-members', chatId, debouncedSearch],
    queryFn: async ({ pageParam, signal }) => {
      const { getChatParticipantsPage } = await import('../lib/api/events-client');
      return getChatParticipantsPage(
        api,
        chatId,
        { roleFilter: 'admins', limit: 100, search: debouncedSearch, cursor: pageParam },
        { signal },
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const options = buildAdminContactOptions(admins.data?.pages.flatMap((page) => page.items) ?? []);

  return (
    <AdminContactPickerPanel search={search} onSearch={setSearch} onClose={close}>
      <div className="admin-contact-picker__list" aria-busy={admins.isFetching}>
        {admins.isPending ? <p role="status">Загрузка администраторов...</p> : null}
        {admins.isError ? (
          <div className="admin-contact-picker__status" role="alert">
            <p>Не удалось загрузить администраторов.</p>
            <button
              type="button"
              disabled={admins.isFetching}
              onClick={() => {
                if (admins.isFetchNextPageError) void admins.fetchNextPage();
                else void admins.refetch();
              }}
            >
              <AppIcon
                icon="RefreshDouble"
                width="1.5em"
                height="1.5em"
                style={{ strokeWidth: 1.5 }}
                aria-hidden
              />
              Повторить
            </button>
          </div>
        ) : null}
        {!admins.isPending && !admins.isError && options.length === 0 ? (
          <p role="status">
            {admins.hasNextPage ? 'Поиск администраторов...' : 'Администраторы не найдены.'}
          </p>
        ) : null}
        {options.map((option) => (
          <button
            key={option.userId}
            type="button"
            className="admin-contact-picker__option"
            disabled={!option.contactUrl || search.trim() !== debouncedSearch}
            aria-pressed={checked && option.contactUrl === url}
            onClick={() => {
              if (!option.contactUrl) return;
              onSelect(option.contactUrl, option.userDisplayName);
              close();
            }}
          >
            <PersonAvatar
              avatarUrl={option.avatarUrl}
              fallback={option.userDisplayName.slice(0, 1)}
              className="admin-contact-picker__avatar"
            />
            <span className="admin-contact-picker__copy">
              <span>{option.userDisplayName}</span>
              <small>
                {!option.contactUrl
                  ? 'Профиль недоступен'
                  : option.role === 'owner'
                    ? 'Владелец'
                    : 'Администратор'}
              </small>
            </span>
            {checked && option.contactUrl === url ? (
              <AppIcon
                icon="Check"
                width="1.5em"
                height="1.5em"
                style={{ strokeWidth: 1.5 }}
                aria-hidden
              />
            ) : null}
          </button>
        ))}
        {admins.hasNextPage && !admins.isError ? (
          <button
            type="button"
            className="admin-contact-picker__more"
            disabled={admins.isFetching}
            onClick={() => void admins.fetchNextPage()}
          >
            {admins.isFetchingNextPage ? 'Загрузка...' : 'Показать ещё'}
          </button>
        ) : null}
      </div>
    </AdminContactPickerPanel>
  );
}
