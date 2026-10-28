import { useEffect, useRef } from 'react';
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

export default function MarketplaceButtonPolicy({
  api,
  entityId,
  entityType,
  profile,
  canEnable,
  onBusyChange,
}: MarketplaceProfileCardProps & { canEnable: boolean; onBusyChange: (value: boolean) => void }) {
  const cache = useQueryClient();
  const queryKey = ['marketplace-button-policy', profile, entityType, entityId];
  const path = marketplaceEntityPath(profile, entityType, entityId, 'button-policy');
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: async () => marketplaceButtonPolicyStateSchema.parse(await api.request(path)),
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: (q) =>
      q.state.error instanceof ApiRequestError && q.state.error.status === 403 ? false : 60_000,
  });
  const mutation = useMutation({
    mutationFn: async ({
      context,
      enabled,
    }: {
      context: MarketplaceButtonContext;
      enabled: boolean;
    }) => {
      if (!query.data) throw new Error('Сначала проверьте настройки кнопки');
      const change = { expectedRevision: query.data.revision, context, enabled };
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
    onSuccess: (result) => {
      cache.setQueryData(queryKey, (previous: MarketplaceButtonPolicyState | undefined) =>
        mergeMarketplaceButtonPolicy(result, previous),
      );
      attempt.current = null;
      void cache.invalidateQueries({ queryKey });
    },
    onError: () => void cache.invalidateQueries({ queryKey }),
  });
  useEffect(() => {
    onBusyChange(mutation.isPending);
  }, [mutation.isPending, onBusyChange]);
  const conflict = mutation.error instanceof ApiRequestError && mutation.error.status === 409;
  return (
    <section className="marketplace-profile__section" aria-label="Кнопка профиля в Биржике">
      <h3>Кнопка «Профиль в Биржике»</h3>
      {query.isPending && <p role="status">Проверяем настройки кнопки…</p>}
      {query.data?.contexts.map((item) => (
        <div key={item.context}>
          <label className="marketplace-profile__toggle">
            <span>
              <strong>{marketplaceButtonLabels[item.context]}</strong>
              {marketplaceButtonStatus[item.status] && (
                <small>{marketplaceButtonStatus[item.status]}</small>
              )}
            </span>
            <span className="marketplace-profile__switch">
              <input
                type="checkbox"
                aria-label={marketplaceButtonLabels[item.context]}
                checked={item.enabled}
                disabled={mutation.isPending || (!item.enabled && (!canEnable || query.isError))}
                onChange={(event) =>
                  mutation.mutate({ context: item.context, enabled: event.target.checked })
                }
              />
              <span className="marketplace-profile__track" aria-hidden />
            </span>
          </label>
          {item.enabled && item.status === 'CONFIRM_REQUIRED' && (
            <button
              type="button"
              className="button button--ghost"
              disabled={mutation.isPending || !canEnable || query.isError}
              onClick={() => mutation.mutate({ context: item.context, enabled: true })}
            >
              Подтвердить включение
            </button>
          )}
        </div>
      ))}
      {!canEnable && !query.isPending && (
        <p className="marketplace-profile-card__intro">
          Для включения нужен доступный опубликованный профиль.
        </p>
      )}
      {query.data?.buttonDiagnostic === 'KEYBOARD_FULL' && (
        <p role="status">Для кнопки не хватило места. Остальные кнопки сохранены.</p>
      )}
      {mutation.isError && (
        <p role="alert">
          {conflict
            ? 'Настройки изменил другой администратор. Проверьте текущее состояние и повторите выбор.'
            : 'Не удалось подтвердить сохранение. Проверьте состояние и повторите.'}
        </p>
      )}
      {query.isError && <p role="alert">Не удалось обновить настройки кнопки.</p>}
      {(query.isError || mutation.isError) && (
        <button
          className="button button--ghost"
          disabled={query.isFetching || mutation.isPending}
          onClick={() => void query.refetch()}
        >
          Проверить настройки кнопки
        </button>
      )}
    </section>
  );
}
