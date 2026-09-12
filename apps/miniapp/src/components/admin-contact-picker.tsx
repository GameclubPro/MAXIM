import { useInfiniteQuery } from '@tanstack/react-query';
import { Check, RefreshDouble, Search, Xmark } from 'iconoir-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildAdminContactOptions } from '../lib/admin-contact-profile-url';
import type { ApiTransport } from '../lib/api/transport';
import { isTopmostModalDialog, useDialogFocusTrap } from '../lib/dialog-focus';
import { useNativeBackHandler } from '../lib/native-back';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import { PersonAvatar } from './ui/person-avatar';
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
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const overlayStyle = useVisualViewportOverlayStyle(true);
  useDialogFocusTrap(true, panelRef, closeButtonRef);
  useNativeBackHandler(
    () => {
      close();
      return true;
    },
    { priority: 740 },
  );

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

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panelRef.current && isTopmostModalDialog(panelRef.current)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [close]);

  const portalTarget = document.querySelector('.design-preview__device-screen') ?? document.body;
  return createPortal(
    <div className="admin-contact-picker" style={overlayStyle}>
      <button
        type="button"
        className="admin-contact-picker__backdrop"
        tabIndex={-1}
        aria-label="Закрыть выбор администратора"
        onClick={close}
      />
      <section
        ref={panelRef}
        className="admin-contact-picker__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="admin-contact-picker__header">
          <strong id={titleId}>Администраторы чата</strong>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={close}
            aria-label="Закрыть"
            title="Закрыть"
          >
            <Xmark aria-hidden />
          </button>
        </header>
        <label className="admin-contact-picker__search">
          <Search aria-hidden />
          <input
            type="search"
            value={search}
            maxLength={100}
            placeholder="Поиск по имени"
            aria-label="Поиск администратора"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
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
                <RefreshDouble aria-hidden />
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
              {checked && option.contactUrl === url ? <Check aria-hidden /> : null}
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
      </section>
    </div>,
    portalTarget,
  );
}
