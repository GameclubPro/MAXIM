import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { canShareNativeContent, shareNativeContent } from '../../../lib/max-bridge';
import { MutationFailure, useShop, useShopMutation } from './runtime';
import { sellerApplicationUrl } from './shop-journey';

function useSellerAccessState() {
  const { module } = useShop();
  const market = module.marketplace!;
  const allowed = module.permissions.includes('manage_marketplace') && market.status !== 'archived';
  const invitation = market.admissionPolicy === 'invitation';
  const publicUrl = sellerApplicationUrl(module.sellerBotUrl, market.id);
  const [link, setLink] = useState<{ id: string; url: string | null; expiresAt: number } | null>(
    null,
  );
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const epoch = useRef(0);
  const invitationAttempt = useRef<{ commandId: string; epoch: number } | null>(null);
  const mutation = useShopMutation();
  const clear = () => {
    epoch.current++;
    invitationAttempt.current = null;
    setLink(null);
    setRevealed(false);
    setCopied(false);
    setCopyError(false);
    setSharing(false);
  };
  useEffect(() => {
    clear();
    mutation.reset();
    return () => {
      epoch.current++;
    };
  }, [allowed, invitation, market.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (
      !allowed ||
      !invitation ||
      !mutation.isSuccess ||
      mutation.variables?.operation !== 'invitation_create' ||
      invitationAttempt.current?.commandId !== mutation.variables.input.commandId ||
      invitationAttempt.current.epoch !== epoch.current ||
      !mutation.data ||
      !('url' in mutation.data) ||
      !('id' in mutation.data)
    )
      return;
    setLink({
      id: mutation.data.id,
      url: mutation.data.url as string | null,
      expiresAt: Date.parse(mutation.data.expiresAt),
    });
    setRevealed(true);
  }, [allowed, invitation, mutation.isSuccess, mutation.data, mutation.variables]);
  const url = invitation ? (link?.url ?? null) : publicUrl;
  const share = async (copyOnly = false) => {
    if (!allowed || mutation.isPending || mutation.isError || sharing) return;
    const current = ++epoch.current;
    setSharing(true);
    setCopied(false);
    setCopyError(false);
    setRevealed(true);
    let copying = false;
    try {
      let target = url;
      if (invitation && (!link || link.expiresAt <= Date.now())) {
        const commandId = crypto.randomUUID();
        invitationAttempt.current = { commandId, epoch: current };
        const result = await mutation.mutateAsync({
          operation: 'invitation_create',
          input: {
            commandId,
            expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            maxUses: 1000,
            targetMaxUserId: null,
          },
        });
        if (current !== epoch.current || !('url' in result)) return;
        target = result.url;
      }
      if (!target || current !== epoch.current) return;
      if (!copyOnly && canShareNativeContent()) {
        try {
          await shareNativeContent({ link: target, preferMax: true });
          return;
        } catch {
          // FLAG: Recheck the access context below before falling back to the clipboard.
        }
      }
      if (current !== epoch.current) return;
      copying = true;
      await navigator.clipboard.writeText(target);
      if (current === epoch.current) setCopied(true);
    } catch {
      if (current === epoch.current && copying) setCopyError(true);
    } finally {
      if (current === epoch.current) setSharing(false);
    }
  };
  return {
    allowed,
    invitation,
    link,
    url,
    revealed,
    copied,
    copyError,
    sharing,
    mutation,
    share,
    clear,
  };
}
const SellerAccessContext = createContext<ReturnType<typeof useSellerAccessState> | null>(null);
export function SellerAccessProvider({ children }: { children: ReactNode }) {
  return (
    <SellerAccessContext.Provider value={useSellerAccessState()}>
      {children}
    </SellerAccessContext.Provider>
  );
}
export function useSellerAccess() {
  const value = useContext(SellerAccessContext);
  if (!value) throw new Error('Missing seller access');
  return value;
}
export function SellerAccessAction({ primary = false }: { primary?: boolean }) {
  const access = useSellerAccess();
  if (!access.allowed) return null;
  const disabled =
    access.sharing ||
    access.mutation.isPending ||
    access.mutation.isError ||
    (access.invitation ? !!access.link && !access.url : !access.url);
  return (
    <div className="karavan-module__actions karavan-shop__seller-access">
      <button
        type="button"
        className={primary ? 'karavan-module__primary' : undefined}
        disabled={disabled}
        onClick={() => void access.share()}
      >
        {access.sharing
          ? 'Готовим ссылку…'
          : access.invitation
            ? 'Пригласить продавца'
            : 'Ссылка для продавцов'}
      </button>
      <MutationFailure mutation={access.mutation} />
      {access.copied ? <p role="status">Ссылка скопирована</p> : null}
      {access.revealed && access.url ? (
        <>
          <label className="karavan-module__field">
            Ссылка для продавцов
            <input readOnly value={access.url} onFocus={(event) => event.currentTarget.select()} />
          </label>
          {canShareNativeContent() ? (
            <button type="button" disabled={disabled} onClick={() => void access.share(true)}>
              Скопировать ссылку
            </button>
          ) : null}
          {access.invitation && access.link ? (
            <p>
              До{' '}
              {new Date(access.link.expiresAt).toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          ) : null}
        </>
      ) : null}
      {access.copyError ? (
        <p role="alert">Не удалось скопировать. Нажмите на ссылку и выберите «Копировать».</p>
      ) : null}
      {access.invitation && access.link && !access.url ? (
        <p role="alert">Ссылка не сохранилась. Отзовите это приглашение и создайте новое.</p>
      ) : null}
      {!access.invitation && !access.url ? (
        <p role="status">Ссылка для продавцов пока недоступна.</p>
      ) : null}
    </div>
  );
}
