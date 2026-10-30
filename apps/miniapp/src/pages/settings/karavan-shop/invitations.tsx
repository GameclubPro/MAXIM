import { useEffect, useState } from 'react';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShopMutation,
  useShopQuery,
} from './runtime';
import { useSellerAccess } from './seller-access';

export default function ShopInvitations() {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const access = useSellerAccess();
  useEffect(() => setCursor(null), [access.link?.id]);
  const query = useShopQuery<'invitations'>(
    { operation: 'invitations', input: { cursor, limit: 24 } },
    open,
  );
  const mutation = useShopMutation((command) => {
    if (command.operation === 'invitation_revoke' && command.input.invitationId === access.link?.id)
      access.clear();
  });
  return (
    <details
      className="karavan-shop__invitations"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Действующие приглашения</summary>
      <MutationFailure mutation={mutation} />
      {open && query.isPending ? <ShopLoading /> : null}
      {query.isError ? (
        <ShopFailure error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {query.data?.invitations
        .filter((item) => !item.revoked && Date.parse(item.expiresAt) > Date.now())
        .map((item) => (
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
            <button
              type="button"
              disabled={mutation.isPending || mutation.isError}
              onClick={() =>
                mutation.mutate({
                  operation: 'invitation_revoke',
                  input: { commandId: crypto.randomUUID(), invitationId: item.id },
                })
              }
            >
              Отозвать приглашение
            </button>
          </div>
        ))}
      {query.data &&
      !query.data.invitations.some(
        (item) => !item.revoked && Date.parse(item.expiresAt) > Date.now(),
      ) ? (
        <p>Действующих приглашений нет</p>
      ) : null}
      {query.data?.nextCursor ? (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => setCursor(query.data!.nextCursor)}
        >
          Следующие приглашения
        </button>
      ) : null}
      {cursor ? (
        <button type="button" onClick={() => setCursor(null)}>
          В начало списка
        </button>
      ) : null}
    </details>
  );
}
