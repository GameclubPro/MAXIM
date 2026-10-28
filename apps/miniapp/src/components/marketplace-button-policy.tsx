import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  marketplaceButtonPolicyStateSchema,
  marketplaceButtonPolicyMutationSchema,
  type MarketplaceButtonContext,
  type MarketplaceButtonPolicyState,
} from '@maxim/contracts/marketplace-integration';
import { ApiRequestError } from '../lib/api-request-error';
import {
  marketplaceButtonLabels,
  marketplaceButtonStatus,
  marketplaceEntityPath,
  mergeMarketplaceButtonPolicy,
} from '../lib/marketplace-button-policy';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

type PolicyChange = {
  expectedRevision: number;
  context: MarketplaceButtonContext;
  enabled: boolean;
};
type PolicyFailure = {
  change: PolicyChange;
  reason: 'conflict' | 'access' | 'unconfirmed';
};

export default function MarketplaceButtonPolicy({
  api,
  entityId,
  entityType,
  profile,
  canEnable,
  onBusyChange,
  enableUnavailableReason,
  onRecheckProfile,
  recheckingProfile = false,
}: MarketplaceProfileCardProps & {
  canEnable: boolean;
  onBusyChange: (value: boolean) => void;
  enableUnavailableReason?: string;
  onRecheckProfile?: () => void;
  recheckingProfile?: boolean;
}) {
  const cache = useQueryClient();
  const queryKey = ['marketplace-button-policy', profile, entityType, entityId];
  const path = marketplaceEntityPath(profile, entityType, entityId, 'button-policy');
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const writing = useRef(false);
  const [failure, setFailure] = useState<PolicyFailure | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewId = `marketplace-button-preview-${profile}-${entityType}-${entityId}`;
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      mergeMarketplaceButtonPolicy(
        marketplaceButtonPolicyStateSchema.parse(await api.request(path)),
        cache.getQueryData<MarketplaceButtonPolicyState>(queryKey),
      ),
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: (q) =>
      q.state.error instanceof ApiRequestError && q.state.error.status === 403 ? false : 60_000,
  });
  const mutation = useMutation({
    mutationFn: async (change: PolicyChange) => {
      const fingerprint = JSON.stringify(change);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      const input = marketplaceButtonPolicyMutationSchema.parse({
        ...change,
        requestId: attempt.current.id,
      });
      return marketplaceButtonPolicyStateSchema.parse(
        await api.request(path, { method: 'POST', body: JSON.stringify(input) }),
      );
    },
    onMutate: () => setFailure(null),
    onSuccess: (result) => {
      cache.setQueryData(queryKey, (previous: MarketplaceButtonPolicyState | undefined) =>
        mergeMarketplaceButtonPolicy(result, previous),
      );
      attempt.current = null;
      setFailure(null);
      void cache.invalidateQueries({ queryKey });
    },
    onError: async (error, change) => {
      setFailure({
        change,
        reason:
          error instanceof ApiRequestError && error.status === 409
            ? 'conflict'
            : error instanceof ApiRequestError && [401, 403].includes(error.status)
              ? 'access'
              : 'unconfirmed',
      });
      // FLAG: A lost response does not establish whether the write committed. Keep
      // its idempotency key and reread before allowing another choice.
      await cache.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      writing.current = false;
    },
  });
  useEffect(() => {
    onBusyChange(mutation.isPending);
  }, [mutation.isPending, onBusyChange]);
  const accessDenied =
    query.error instanceof ApiRequestError && [401, 403].includes(query.error.status);
  const changedContext = query.data?.contexts.find(
    (item) => item.context === failure?.change.context,
  );
  // FLAG: This only confirms the current setting, never which administrator wrote it.
  // A still-enabled but unconfirmed policy must not hide a failed reconfirmation.
  const reconciled =
    failure?.reason === 'unconfirmed' &&
    !query.isError &&
    !!query.data &&
    query.data.revision > failure.change.expectedRevision &&
    changedContext?.enabled === failure.change.enabled &&
    (!failure.change.enabled || changedContext.status !== 'CONFIRM_REQUIRED');
  const showFailure = !!failure && !reconciled && !mutation.isPending;
  const change = (context: MarketplaceButtonContext, enabled: boolean) => {
    if (
      writing.current ||
      !query.data ||
      accessDenied ||
      (enabled && (!canEnable || query.isError))
    )
      return;
    writing.current = true;
    mutation.mutate({ context, enabled, expectedRevision: query.data.revision });
  };
  const contextLabel = (context: MarketplaceButtonContext) =>
    context === 'PUBLICATIONS' && profile === 'publisher'
      ? 'В публикациях Публика'
      : marketplaceButtonLabels[context];
  return (
    <section className="marketplace-button-policy" aria-label="Кнопка в сообщениях">
      {query.isPending && <p role="status">Проверяем настройки кнопки…</p>}
      <div className="marketplace-button-policy__choices">
        {query.data?.contexts.map((item) => (
          <div key={item.context}>
            <label className="marketplace-profile__toggle">
              <span>
                <strong>{contextLabel(item.context)}</strong>
                {marketplaceButtonStatus[item.status] && (
                  <small>{marketplaceButtonStatus[item.status]}</small>
                )}
              </span>
              <span className="marketplace-profile__switch">
                <input
                  type="checkbox"
                  aria-label={contextLabel(item.context)}
                  checked={item.enabled}
                  disabled={
                    mutation.isPending ||
                    accessDenied ||
                    (!item.enabled && (!canEnable || query.isError))
                  }
                  onChange={(event) => change(item.context, event.target.checked)}
                />
                <span className="marketplace-profile__track" aria-hidden />
              </span>
            </label>
            {item.enabled && item.status === 'CONFIRM_REQUIRED' && (
              <button
                type="button"
                className="button button--ghost"
                disabled={mutation.isPending || !canEnable || query.isError}
                onClick={() => change(item.context, true)}
              >
                Подтвердить включение
              </button>
            )}
          </div>
        ))}
      </div>
      {mutation.isPending && (
        <p role="status">{failure ? 'Проверяем сохранение…' : 'Сохраняем…'}</p>
      )}
      {!canEnable && !query.isPending && (
        <div>
          <p className="marketplace-profile-card__intro">
            {enableUnavailableReason ?? 'Для кнопки нужен опубликованный профиль.'}
          </p>
          {enableUnavailableReason && onRecheckProfile && (
            <button
              type="button"
              className="button button--ghost"
              disabled={recheckingProfile}
              onClick={onRecheckProfile}
            >
              Проверить профиль
            </button>
          )}
        </div>
      )}
      {query.data?.buttonDiagnostic === 'KEYBOARD_FULL' && (
        <p role="status">Под сообщением нет места для ещё одной кнопки.</p>
      )}
      {showFailure && (
        <p role="alert">
          {failure.reason === 'conflict'
            ? 'Настройки изменил другой администратор. Проверьте их и повторите выбор.'
            : failure.reason === 'access'
              ? 'Доступ к настройкам не подтверждён. Проверьте права администратора.'
              : 'Сохранение не подтверждено. Проверьте настройки и повторите.'}
        </p>
      )}
      {query.isError && !showFailure && !mutation.isPending && (
        <p role="alert">
          {accessDenied
            ? 'Доступ к настройкам не подтверждён. Проверьте права администратора.'
            : 'Не удалось обновить настройки кнопки.'}
        </p>
      )}
      {(query.isError || showFailure) && !mutation.isPending && (
        <button
          className="button button--ghost"
          disabled={query.isFetching || mutation.isPending}
          onClick={() => void query.refetch()}
        >
          Проверить настройки
        </button>
      )}
      <div className="marketplace-button-policy__preview">
        <button
          type="button"
          className="button button--ghost marketplace-button-policy__preview-toggle"
          aria-expanded={previewOpen}
          aria-controls={previewId}
          onClick={() => setPreviewOpen((open) => !open)}
        >
          Как выглядит кнопка
        </button>
        <div id={previewId} hidden={!previewOpen}>
          <div className="marketplace-button-policy__sample">Профиль в Биржике</div>
          <p className="marketplace-profile-card__intro">Добавляется в новые сообщения.</p>
        </div>
      </div>
    </section>
  );
}
