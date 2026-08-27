import type { ManagedEntityType } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Post } from 'iconoir-react';
import type { ApiTransport } from '../lib/api/transport';
import { getPublisherEntity, updatePublisherPolicy } from '../lib/api/publisher-client';
import { describeUserFacingError } from '../lib/user-facing-error';
import { cn } from '../lib/cn';
import { GlassCard } from './ui/glass-card';
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
  const queryKey = ['publisher-entity', entityType, entityId] as const;
  const entityQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getPublisherEntity(api, entityType, entityId, { signal }),
    enabled: Boolean(entityId),
  });
  const mutation = useMutation({
    mutationFn: (publikEnabled: boolean) =>
      updatePublisherPolicy(api, entityType, entityId, {
        expectedRevision: entityQuery.data?.policy.revision ?? 0,
        publikEnabled,
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
      <GlassCard className="publisher-policy-card" padding="sm" aria-busy="true">
        <div className="publisher-policy-card__row">
          <span className="publisher-policy-card__icon" aria-hidden>
            <Post />
          </span>
          <strong className="publisher-policy-card__title">Публик</strong>
          <span className="publisher-policy-card__switch-placeholder" aria-hidden />
        </div>
      </GlassCard>
    );
  }

  if (!entityQuery.data) {
    return (
      <GlassCard
        className="publisher-policy-card has-error"
        padding="sm"
        role="alert"
        aria-label={describeUserFacingError(
          entityQuery.error,
          'Не удалось загрузить настройку Публика',
        )}
      >
        <div className="publisher-policy-card__row">
          <span className="publisher-policy-card__icon" aria-hidden>
            <Post />
          </span>
          <strong className="publisher-policy-card__title">Публик</strong>
          <label className="settings-native-switch publisher-policy-card__switch">
            <input
              type="checkbox"
              checked={false}
              disabled
              aria-label="Настройка Публика недоступна"
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </GlassCard>
    );
  }

  const entity = entityQuery.data;
  return (
    <GlassCard
      className={cn('publisher-policy-card', entity.policy.publikEnabled && 'is-enabled')}
      padding="sm"
      aria-busy={mutation.isPending || entityQuery.isFetching}
    >
      <div className="publisher-policy-card__row">
        <span className="publisher-policy-card__icon" aria-hidden>
          <Post />
        </span>
        <strong className="publisher-policy-card__title">Публик</strong>
        <label className="settings-native-switch publisher-policy-card__switch">
          <input
            type="checkbox"
            checked={entity.policy.publikEnabled}
            disabled={mutation.isPending}
            aria-label={`${entity.policy.publikEnabled ? 'Выключить' : 'Включить'} Публик для ${
              entityType === 'channel' ? 'канала' : 'чата'
            }`}
            onChange={(event) => mutation.mutate(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
    </GlassCard>
  );
}
