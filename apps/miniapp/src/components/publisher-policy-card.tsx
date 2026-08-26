import type { ManagedEntityType } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Post, Refresh } from 'iconoir-react';
import { useId } from 'react';
import type { ApiTransport } from '../lib/api/transport';
import { getPublisherEntity, updatePublisherPolicy } from '../lib/api/publisher-client';
import { describeUserFacingError } from '../lib/user-facing-error';
import { cn } from '../lib/cn';
import { getPublisherReadinessPresentation } from '../lib/publisher-readiness';
import { GlassCard } from './ui/glass-card';
import { SkeletonCard } from './ui/skeleton';
import { useToast } from './ui/toast';
import './publisher-policy-card.css';

export function PublisherPolicyCard({
  api,
  entityType,
  entityId,
}: {
  api: ApiTransport;
  entityType: ManagedEntityType;
  entityId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const statusId = useId();
  const queryKey = ['publisher-entity', entityType, entityId] as const;
  const entityQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getPublisherEntity(api, entityType, entityId, { signal }),
    enabled: Boolean(entityId),
  });
  const mutation = useMutation({
    mutationFn: (change: { publikEnabled?: boolean; suggestionsViaPublik?: boolean }) =>
      updatePublisherPolicy(api, entityType, entityId, {
        expectedRevision: entityQuery.data?.policy.revision ?? 0,
        ...change,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'sources', 'publisher'] }),
      ]);
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey });
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить'),
      });
    },
  });

  if (entityQuery.isLoading) {
    return (
      <GlassCard className="publisher-policy-card">
        <SkeletonCard lines={2} />
      </GlassCard>
    );
  }
  if (!entityQuery.data) {
    return (
      <GlassCard className="publisher-policy-card has-error" role="alert">
        <div className="publisher-policy-card__row">
          <span className="publisher-policy-card__icon" aria-hidden>
            <Post />
          </span>
          <span className="publisher-policy-card__copy">
            <strong>Публик</strong>
            <small>
              {describeUserFacingError(entityQuery.error, 'Не удалось загрузить настройку')}
            </small>
          </span>
          <button
            type="button"
            className="publisher-policy-card__retry"
            aria-label="Повторить загрузку настройки Публика"
            title="Повторить"
            disabled={entityQuery.isFetching}
            onClick={() => void entityQuery.refetch()}
          >
            <Refresh aria-hidden />
          </button>
        </div>
      </GlassCard>
    );
  }

  const entity = entityQuery.data;
  const presentation = getPublisherReadinessPresentation(entity.readiness);
  const disabled = mutation.isPending;
  return (
    <GlassCard
      className={cn(
        'publisher-policy-card',
        entity.policy.publikEnabled && 'is-enabled',
        entity.readiness.state === 'ready' && 'is-ready',
      )}
      elevated
      aria-busy={mutation.isPending || entityQuery.isFetching}
    >
      <div className="publisher-policy-card__row">
        <span className="publisher-policy-card__icon" aria-hidden>
          <Post />
        </span>
        <span className="publisher-policy-card__copy">
          <strong>Публик</strong>
          <small id={statusId} role="status" aria-live="polite">
            {mutation.isPending ? 'Сохраняю...' : presentation.label}
          </small>
        </span>
        <label className="settings-native-switch publisher-policy-card__switch">
          <input
            type="checkbox"
            checked={entity.policy.publikEnabled}
            disabled={disabled}
            aria-label={`${entity.policy.publikEnabled ? 'Выключить' : 'Включить'} Публик для ${
              entityType === 'channel' ? 'канала' : 'чата'
            }`}
            aria-describedby={statusId}
            onChange={(event) => mutation.mutate({ publikEnabled: event.target.checked })}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>

      {entityType === 'channel' && entity.policy.publikEnabled ? (
        <div className="publisher-policy-card__row publisher-policy-card__row--secondary">
          <span className="publisher-policy-card__copy">
            <strong>Одобренные предложения</strong>
            <small>{entity.policy.suggestionsViaPublik ? 'Через Публик' : 'Основной бот'}</small>
          </span>
          <label className="settings-native-switch publisher-policy-card__switch">
            <input
              type="checkbox"
              checked={entity.policy.suggestionsViaPublik}
              disabled={disabled}
              aria-label="Публиковать одобренные предложения через Публик"
              aria-describedby={statusId}
              onChange={(event) => mutation.mutate({ suggestionsViaPublik: event.target.checked })}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      ) : null}

      {entity.policy.publikEnabled && entity.readiness.state !== 'ready' ? (
        <div className="publisher-policy-card__readiness" role="status">
          <span>{presentation.detail}</span>
          <button
            type="button"
            onClick={() => void entityQuery.refetch()}
            disabled={entityQuery.isFetching || mutation.isPending}
          >
            <Refresh aria-hidden />
            <span>{entityQuery.isFetching ? 'Обновляю' : 'Обновить'}</span>
          </button>
        </div>
      ) : null}
    </GlassCard>
  );
}
