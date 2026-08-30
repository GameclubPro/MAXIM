import type { ManagedEntityType } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import type { ApiTransport } from '../lib/api/transport';
import { getPublisherPolicy, updatePublisherPolicy } from '../lib/api/publisher-client';
import type { BotPermissionBlocker } from '../lib/bot-permission-error';
import { describeUserFacingError } from '../lib/user-facing-error';
import { cn } from '../lib/cn';
import { useToast } from './ui/toast';
import './publisher-policy-card.css';

let botPermissionErrorModulePromise: Promise<typeof import('../lib/bot-permission-error')> | null =
  null;

function loadBotPermissionErrorModule() {
  botPermissionErrorModulePromise ??= import('../lib/bot-permission-error');
  return botPermissionErrorModulePromise;
}

const LazyBotPermissionRequiredDialog = lazy(() =>
  import('./bot-permission-required-dialog').then((module) => ({
    default: module.BotPermissionRequiredDialog,
  })),
);

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
  const [permissionBlocker, setPermissionBlocker] = useState<BotPermissionBlocker | null>(null);
  const queryKey = ['publisher-policy', entityType, entityId] as const;
  const policyQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getPublisherPolicy(api, entityType, entityId, { signal }),
    enabled: Boolean(entityId),
  });
  const mutation = useMutation({
    mutationFn: (publikEnabled: boolean) =>
      updatePublisherPolicy(api, entityType, entityId, {
        expectedRevision: policyQuery.data?.revision ?? 0,
        publikEnabled,
      }),
    onSuccess: async () => {
      setPermissionBlocker(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({
          queryKey: ['publisher-entity', entityType, entityId],
        }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'sources', 'publisher'] }),
      ]);
    },
    onError: async (error) => {
      void queryClient.invalidateQueries({ queryKey });
      const { parseBotPermissionBlocker } = await loadBotPermissionErrorModule();
      const blocker = parseBotPermissionBlocker(error);
      if (blocker) {
        setPermissionBlocker(blocker);
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить'),
      });
    },
  });

  const policy = policyQuery.data;
  const unavailable = !policyQuery.isLoading && !policy;
  const switchLabel = policy
    ? `${policy.publikEnabled ? 'Выключить' : 'Включить'} Публик для ${
        entityType === 'channel' ? 'канала' : 'чата'
      }`
    : unavailable
      ? 'Настройка Публика недоступна'
      : 'Публик загружается';
  return (
    <div
      className={cn('publisher-policy-card', unavailable && 'has-error')}
      role={unavailable ? 'alert' : undefined}
      aria-label={
        unavailable
          ? describeUserFacingError(policyQuery.error, 'Не удалось загрузить Публик')
          : undefined
      }
      aria-busy={policyQuery.isLoading || mutation.isPending || policyQuery.isFetching}
    >
      <strong className="publisher-policy-card__title">Публик</strong>
      <label className="settings-native-switch publisher-policy-card__switch">
        <input
          type="checkbox"
          checked={policy?.publikEnabled ?? false}
          disabled={!policy || mutation.isPending}
          aria-label={switchLabel}
          onChange={(event) => mutation.mutate(event.target.checked)}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </label>

      <Suspense fallback={null}>
        <LazyBotPermissionRequiredDialog
          id="publisher-policy-permission"
          blocker={permissionBlocker}
          isRechecking={mutation.isPending}
          onClose={() => setPermissionBlocker(null)}
          onRecheck={() => {
            setPermissionBlocker(null);
            mutation.mutate(true);
          }}
        />
      </Suspense>
    </div>
  );
}
