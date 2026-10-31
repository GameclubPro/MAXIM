import { useState } from 'react';
import { useStorefrontDirty } from '../storefront-workspace';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShopMutation,
  useShopPages,
  useShop,
} from './runtime';
import { useSellerAccess } from './seller-access';
import { uniqueShopItems } from './shop-journey';

export default function ShopInvitations() {
  const [open, setOpen] = useState(false);
  const { module } = useShop();
  const access = useSellerAccess();
  const query = useShopPages<'invitations'>(
    { operation: 'invitations', input: { cursor: null, limit: 24 } },
    open,
  );
  const mutation = useShopMutation({ owner: 'invitation-revoke', page: 'settings' }, (command) => {
    if (command.operation === 'invitation_revoke' && command.input.invitationId === access.link?.id)
      access.clear();
  });
  useStorefrontDirty('invitations', mutation.uncertain);
  const invitations = uniqueShopItems(
    query.data?.pages.map((page) => page.invitations) ?? [],
  ).filter((item) => !item.revoked && Date.parse(item.expiresAt) > Date.now());
  return (
    <details
      className="karavan-shop__invitations"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Действующие приглашения</summary>
      <MutationFailure mutation={mutation} />
      {open && query.isPending ? <ShopLoading /> : null}
      {query.isError && !query.data ? (
        <ShopFailure error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {invitations.map((item) => (
        <div className="karavan-shop__row" key={item.id}>
          <p>
            До{' '}
            {new Date(item.expiresAt).toLocaleString('ru-RU', {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · использовано {item.usedCount}
          </p>
          {module.permissions.includes('manage_marketplace') ? (
            <button
              type="button"
              disabled={mutation.blocked}
              onClick={() =>
                mutation.mutate({
                  operation: 'invitation_revoke',
                  input: { commandId: crypto.randomUUID(), invitationId: item.id },
                })
              }
            >
              Отозвать приглашение
            </button>
          ) : null}
        </div>
      ))}
      {query.data && !invitations.length ? <p>Действующих приглашений нет</p> : null}
      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
      {query.isFetchNextPageError ? (
        <ShopFailure error={query.error} retry={() => void query.fetchNextPage()} />
      ) : null}
    </details>
  );
}
