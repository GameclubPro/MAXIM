import { useEffect, useRef, useState } from 'react';
import { MutationFailure, ShopFailure, useShopMutation, useShopQuery } from './runtime';
export default function ShopInvitations() {
  const [cursor, setCursor] = useState<string | null>(null),
    [link, setLink] = useState<string | null>(null),
    [linkId, setLinkId] = useState<string | null>(null),
    [linkExpiry, setLinkExpiry] = useState<number | null>(null),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false),
    [lost, setLost] = useState(false);
  const copyEpoch = useRef(0);
  const clearLink = () => {
    copyEpoch.current++;
    setLink(null);
    setLinkId(null);
    setLinkExpiry(null);
    setCopied(false);
    setCopyError(false);
    setLost(false);
  };
  useEffect(
    () => () => {
      copyEpoch.current++;
    },
    [],
  );
  const query = useShopQuery<'invitations'>({
    operation: 'invitations',
    input: { cursor, limit: 24 },
  });
  const mutation = useShopMutation((command) => {
    if (command.operation === 'invitation_revoke' && command.input.invitationId === linkId) {
      clearLink();
    }
  });
  const copy = async (url: string) => {
    const epoch = ++copyEpoch.current;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(url);
      if (epoch !== copyEpoch.current) return;
      setCopied(true);
      setLost(false);
    } catch {
      if (epoch !== copyEpoch.current) return;
      setCopied(false);
      setCopyError(true);
    }
  };
  useEffect(() => {
    if (
      mutation.isSuccess &&
      mutation.variables?.operation === 'invitation_create' &&
      mutation.data &&
      'url' in mutation.data &&
      'id' in mutation.data
    ) {
      const url = mutation.data.url as string | null;
      setLink(url);
      setLinkId(mutation.data.id);
      setLinkExpiry(Date.parse(mutation.data.expiresAt));
      setLost(!url);
      setCursor(null);
      if (url) void copy(url);
    }
  }, [mutation.isSuccess, mutation.data, mutation.variables]);
  return (
    <div className="karavan-module__actions">
      <MutationFailure
        mutation={mutation}
        onRefresh={() => {
          copyEpoch.current++;
        }}
      />
      <button
        type="button"
        disabled={mutation.isPending || mutation.isError || lost}
        onClick={() => {
          if (link && linkExpiry !== null && linkExpiry > Date.now()) {
            void copy(link);
            return;
          }
          clearLink();
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
        {copied ? 'Скопировано' : 'Скопировать приглашение'}
      </button>
      {link ? (
        <>
          <label className="karavan-module__field">
            Ссылка для продавцов
            <input readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          </label>
          {copyError ? (
            <p role="alert">Не удалось скопировать. Нажмите на ссылку и выберите «Копировать».</p>
          ) : null}
          <p>Действует 7 дней</p>
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
              disabled={mutation.isPending || mutation.isError}
              onClick={() => {
                copyEpoch.current++;
                mutation.mutate({
                  operation: 'invitation_revoke',
                  input: { commandId: crypto.randomUUID(), invitationId: item.id },
                });
              }}
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
      {cursor ? (
        <button type="button" onClick={() => setCursor(null)}>
          В начало списка
        </button>
      ) : null}
    </div>
  );
}
