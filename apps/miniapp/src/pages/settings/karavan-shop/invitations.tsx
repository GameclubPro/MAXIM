import { useEffect, useState } from 'react';
import { MutationFailure, ShopFailure, useShopMutation, useShopQuery } from './runtime';
export default function ShopInvitations() {
  const [cursor, setCursor] = useState<string | null>(null),
    [link, setLink] = useState<string | null>(null),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false),
    [lost, setLost] = useState(false);
  const query = useShopQuery<'invitations'>({
    operation: 'invitations',
    input: { cursor, limit: 24 },
  });
  const mutation = useShopMutation();
  useEffect(() => {
    if (
      mutation.isSuccess &&
      mutation.variables?.operation === 'invitation_create' &&
      mutation.data &&
      'url' in mutation.data
    ) {
      setLink(mutation.data.url as string | null);
      setLost(!mutation.data.url);
    }
  }, [mutation.isSuccess, mutation.data, mutation.variables]);
  return (
    <div className="karavan-module__actions">
      <MutationFailure mutation={mutation} />
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => {
          setLost(false);
          setCopied(false);
          setCopyError(false);
          void mutation
            .mutateAsync({
              operation: 'invitation_create',
              input: {
                commandId: crypto.randomUUID(),
                expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
                maxUses: 1000,
                targetMaxUserId: null,
              },
            })
            .catch(() => {});
        }}
      >
        Создать приглашение
      </button>
      {link ? (
        <>
          <label className="karavan-module__field">
            Ссылка для продавцов
            <input readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <button
            type="button"
            onClick={() => {
              setCopyError(false);
              void (navigator.clipboard?.writeText(link) ?? Promise.reject())
                .then(() => setLost(false))
                .then(() => setCopied(true))
                .catch(() => {
                  setCopied(false);
                  setCopyError(true);
                });
            }}
          >
            {copied ? 'Скопировано' : 'Скопировать ссылку'}
          </button>
          {copyError ? (
            <p role="alert">Не удалось скопировать. Нажмите на ссылку и выберите «Копировать».</p>
          ) : null}
          <p>Действует 7 дней. Продавцы подают заявки на размещение.</p>
        </>
      ) : null}
      {lost ? (
        <p role="alert">Ссылка не сохранилась. Отзовите это приглашение и создайте новое.</p>
      ) : null}
      {query.isError ? (
        <ShopFailure error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {query.data?.invitations
        .filter((item) => !item.revoked && Date.parse(item.expiresAt) > Date.now())
        .map((item) => (
          <div className="karavan-shop__row" key={item.id}>
            <p>
              До {new Date(item.expiresAt).toLocaleDateString('ru-RU')} · использовано{' '}
              {item.usedCount}
            </p>
            <button
              type="button"
              disabled={mutation.isPending}
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
      {query.data?.nextCursor ? (
        <button type="button" onClick={() => setCursor(query.data!.nextCursor)}>
          Следующие приглашения
        </button>
      ) : null}
    </div>
  );
}
