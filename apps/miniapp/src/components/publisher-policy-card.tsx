import type { ManagedEntityType, PublisherEntity } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Post } from 'iconoir-react';
import type { ApiTransport } from '../lib/api/transport';
import { getPublisherEntity, updatePublisherPolicy } from '../lib/api/publisher-client';
import { describeUserFacingError } from '../lib/user-facing-error';
import { cn } from '../lib/cn';
import { GlassCard } from './ui/glass-card';
import { SkeletonCard } from './ui/skeleton';
import { useToast } from './ui/toast';
import './publisher-policy-card.css';

function readinessLabel(entity: PublisherEntity): string {
  switch (entity.readiness.state) {
    case 'ready':
      return 'Готов';
    case 'disabled':
      return 'Выключен';
    case 'temporarily_unavailable':
      return 'Временно недоступен';
    default:
      return 'Требуется подключение';
  }
}

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
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
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
    return null;
  }

  const entity = entityQuery.data;
  const disabled = mutation.isPending;
  return (
    <GlassCard
      className={cn(
        'publisher-policy-card',
        entity.policy.publikEnabled && 'is-enabled',
        entity.readiness.state === 'ready' && 'is-ready',
      )}
      elevated
    >
      <div className="publisher-policy-card__row">
        <span className="publisher-policy-card__icon" aria-hidden>
          <Post />
        </span>
        <span className="publisher-policy-card__copy">
          <strong>Публик</strong>
          <small>{readinessLabel(entity)}</small>
        </span>
        <label className="settings-native-switch publisher-policy-card__switch">
          <input
            type="checkbox"
            checked={entity.policy.publikEnabled}
            disabled={disabled}
            aria-label="Публик"
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
              onChange={(event) => mutation.mutate({ suggestionsViaPublik: event.target.checked })}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      ) : null}
    </GlassCard>
  );
}
