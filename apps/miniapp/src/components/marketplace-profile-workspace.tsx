import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  marketplaceProfileStateSchema,
  marketplaceProfileMutationSchema,
  type MarketplaceProfileState,
} from '@maxim/contracts/marketplace-integration';
import { EntityAvatar } from './ui/entity-avatar';
import { SkeletonCard } from './ui/skeleton';
import { openMaxBotLink } from '../lib/max-bridge';
import { describeUserFacingError } from '../lib/user-facing-error';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

type Details = { title: string; description: string; topic: string; region: string };
type Action = 'save' | 'publish' | 'pause' | 'toggle' | 'revoke';

function initialDetails(state: MarketplaceProfileState): Details {
  return {
    title: state.listing?.title ?? state.binding.metadata.title,
    description: state.listing?.description ?? state.binding.metadata.description.slice(0, 1500),
    topic: state.listing?.topic ?? '',
    region: state.listing?.region ?? '',
  };
}

export default function MarketplaceProfileWorkspace({
  api,
  entityId,
  entityType,
  profile,
}: MarketplaceProfileCardProps) {
  const cache = useQueryClient();
  const queryKey = ['marketplace-profile', profile, entityType, entityId];
  const path = `/marketplace/entities/${entityType === 'channel' ? 'CHANNEL' : 'CHAT'}/${encodeURIComponent(entityId)}/profile?profile=${profile}`;
  const [draft, setDraft] = useState<Details | null>(null);
  const [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState(false);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: async () => marketplaceProfileStateSchema.parse(await api.request(path)),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.binding.state === 'UNKNOWN' ? 5000 : 60_000),
  });
  const mutation = useMutation({
    mutationFn: async ({ action, appendEnabled }: { action: Action; appendEnabled?: boolean }) => {
      const state = query.data!;
      const change = {
        action,
        expectedRevision:
          action === 'toggle' || action === 'revoke' ? state.appendRevision : state.revision,
        ...(action === 'save' ? { details: draft ?? initialDetails(state) } : {}),
        ...(action === 'toggle' ? { appendEnabled } : {}),
        ...(action === 'save' && (consent || state.binding.statisticsConsent)
          ? { statisticsConsent: true as const }
          : {}),
      };
      const fingerprint = JSON.stringify(change);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      const body = marketplaceProfileMutationSchema.parse({
        ...change,
        requestId: attempt.current.id,
      });
      return marketplaceProfileStateSchema.parse(
        await api.request(path, { method: 'POST', body: JSON.stringify(body) }),
      );
    },
    onSuccess: (state, variables) => {
      cache.setQueryData(queryKey, state);
      attempt.current = null;
      if (variables.action === 'save') {
        setDraft(null);
        setSaved(true);
      }
      if (variables.action === 'revoke') {
        setConsent(false);
        setSaved(false);
      }
    },
    onError: () => {
      void cache.invalidateQueries({ queryKey });
    },
  });
  if (query.isPending) return <SkeletonCard lines={5} />;
  if (!query.data)
    return (
      <div className="marketplace-profile">
        <p role="alert">
          {describeUserFacingError(
            query.error,
            'Не удалось проверить площадку. Обновите данные и повторите.',
          )}
        </p>
        <button className="button button--ghost" onClick={() => void query.refetch()}>
          Обновить
        </button>
      </div>
    );
  const state = query.data;
  const details = draft ?? initialDetails(state);
  const active = state.binding.state === 'ACTIVE';
  const revoked = state.binding.state === 'REVOKED' && !state.binding.statisticsConsent;
  const published = state.listing?.status === 'PUBLISHED';
  const pending = mutation.isPending || query.isFetching;
  const hasConsent = state.binding.statisticsConsent || consent;
  const canSave =
    active && hasConsent && details.title.trim() && details.topic && details.region && !pending;
  const edit = (key: keyof Details, value: string) => {
    setDraft({ ...details, [key]: value });
    setSaved(false);
  };
  return (
    <div className="marketplace-profile">
      <div className="marketplace-profile__hero">
        <EntityAvatar
          title={details.title}
          entityType={entityType}
          avatarUrl={state.binding.metadata.imageUrl}
        />
        <div>
          <strong>{details.title || 'Профиль площадки'}</strong>
          <small>
            {revoked
              ? 'Обмен статистикой отключён'
              : published
                ? 'Профиль опубликован'
                : state.listing?.status === 'PAUSED'
                  ? 'Профиль скрыт'
                  : 'Черновик — виден только вам'}
          </small>
        </div>
      </div>
      {!active && (
        <p className="marketplace-profile__notice" role="status">
          {revoked
            ? 'Обмен статистикой и кнопка профиля отключены. Опубликованный профиль можно скрыть отдельно.'
            : state.binding.state === 'UNKNOWN'
              ? 'Проверяем доступ к площадке. Дождитесь подтверждения.'
              : 'Доступ к площадке больше не подтверждён. Проверьте подключение бота и свои права.'}
        </p>
      )}
      {(!state.listing || state.listing.profileOnly) && (
        <p className="marketplace-profile__notice">
          Для размещений подключите бота биржи. Пока доступны профиль и статистика площадки.
        </p>
      )}
      {query.isError && (
        <p role="status">Не удалось обновить состояние. Показаны последние полученные данные.</p>
      )}
      <form
        className="marketplace-profile__form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({ action: 'save' });
        }}
      >
        <label className="field">
          <span>Название</span>
          <input
            value={details.title}
            maxLength={300}
            required
            disabled={mutation.isPending}
            onChange={(event) => edit('title', event.target.value)}
          />
        </label>
        <label className="field">
          <span>Описание</span>
          <textarea
            value={details.description}
            maxLength={1500}
            disabled={mutation.isPending}
            onChange={(event) => edit('description', event.target.value)}
          />
        </label>
        <label className="field">
          <span>Тематика</span>
          <select
            aria-label="Тематика"
            value={details.topic}
            required
            disabled={mutation.isPending}
            onChange={(event) => edit('topic', event.target.value)}
          >
            <option value="">Выберите тематику</option>
            {state.choices.topics.map((topic) => (
              <option key={topic} value={topic}>
                {topic}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Регион</span>
          <select
            aria-label="Регион"
            value={details.region}
            required
            disabled={mutation.isPending}
            onChange={(event) => edit('region', event.target.value)}
          >
            <option value="">Выберите регион</option>
            {state.choices.regions.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </select>
        </label>
        {!state.binding.statisticsConsent && (
          <label className="marketplace-profile__consent">
            <input
              type="checkbox"
              checked={consent}
              disabled={mutation.isPending}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              Разрешаю передавать статистику этой площадки из MAXIM в «Связку» за последние 90 дней
              и обновлять её. Списки участников и тексты сообщений не передаются.
            </span>
          </label>
        )}
        <button className="button button--accent" disabled={!canSave} type="submit">
          {mutation.isPending && mutation.variables?.action === 'save'
            ? 'Сохраняем…'
            : state.listing
              ? 'Сохранить профиль'
              : 'Создать профиль'}
        </button>
        {saved && (
          <p role="status">
            Профиль сохранён.{!published ? ' Опубликуйте его, когда будете готовы.' : ''}
          </p>
        )}
      </form>
      {state.listing && (
        <>
          <div className="marketplace-profile__actions">
            <button
              className="button button--ghost"
              disabled={pending || !active || (!published && draft !== null)}
              onClick={() => mutation.mutate({ action: published ? 'pause' : 'publish' })}
            >
              {published ? 'Скрыть профиль' : 'Опубликовать профиль'}
            </button>
            {published && state.listing.publicUrl && (
              <button
                className="button button--ghost"
                onClick={() => openMaxBotLink(state.listing!.publicUrl!)}
              >
                Открыть на бирже
              </button>
            )}
          </div>
          {!published && (
            <p className="marketplace-profile-card__intro">
              После публикации профиль смогут открыть все посетители биржи.
            </p>
          )}
          <label className="marketplace-profile__toggle">
            <span>
              <strong>Добавлять кнопку профиля к публикациям</strong>
              <small>
                В новых постах этого {entityType === 'channel' ? 'канала' : 'чата'}. Уже
                отправленные сообщения не меняются.
              </small>
            </span>
            <span className="marketplace-profile__switch">
              <input
                type="checkbox"
                checked={state.appendEnabled}
                disabled={pending || (!state.appendEnabled && (!published || !active))}
                onChange={(event) =>
                  mutation.mutate({ action: 'toggle', appendEnabled: event.target.checked })
                }
              />
              <span className="marketplace-profile__track" aria-hidden />
            </span>
          </label>
        </>
      )}
      {mutation.isError && (
        <p role="alert">
          {describeUserFacingError(
            mutation.error,
            'Не удалось сохранить изменение. Обновите состояние и повторите.',
          )}
        </p>
      )}
      {state.buttonDiagnostic === 'KEYBOARD_FULL' && (
        <p className="marketplace-profile__notice" role="status">
          В последней публикации не хватило места для кнопки профиля. Остальные кнопки сохранены.
        </p>
      )}
      {state.binding.statisticsConsent && (
        <button
          className="button button--ghost"
          disabled={pending}
          onClick={() => mutation.mutate({ action: 'revoke' })}
        >
          Отключить обмен статистикой
        </button>
      )}
      <button
        className="button button--ghost"
        disabled={pending}
        onClick={() => void query.refetch()}
      >
        Обновить состояние
      </button>
    </div>
  );
}
