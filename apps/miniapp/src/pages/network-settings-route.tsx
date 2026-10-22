import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { networkChannelSettingsSectionSchema } from '@maxim/contracts/network-settings-read';
import type { ApiTransport } from '../lib/api/transport';
import {
  hydrateNetworkSettingsScope,
  networkChatWorkspaceSectionSchema,
  type StoredNetworkSettingsScope,
} from '../lib/network-settings-workspace-state';
import { NetworkSettingsPage, type NetworkSettingsEditorScope } from './network-settings-page';
import { NetworkSettingsOverview } from './network-settings-overview';
import { useManagedEntityNavigation } from '../lib/managed-entity-navigation';

import { Spinner } from '../components/ui/spinner';
import {
  hydrateNetworkSettingsOperationReceipts,
  listNetworkSettingsOperationReceipts,
} from '../lib/network-settings-operation-storage';
import { resolveNetworkRouteOperation } from '../features/networks/network-route-state';

export function NetworkSettingsRoute({ api, userId }: { api: ApiTransport; userId: string }) {
  const { type, section } = useParams();
  const location = useLocation();
  const { requestNavigation } = useManagedEntityNavigation();
  const query = new URLSearchParams(location.search);
  const scopeId = query.get('scope') ?? '';
  const operationId = query.get('operation') ?? undefined;
  const identity = `${userId}:${type}:${scopeId}`;
  const [loaded, setLoaded] = useState<{
    identity: string;
    value: StoredNetworkSettingsScope | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if ((type !== 'chat' && type !== 'channel') || !/^[a-f0-9-]{36}$/iu.test(scopeId)) {
      setLoaded({ identity, value: null });
      return;
    }
    void Promise.all([
      hydrateNetworkSettingsScope({ userId, scopeId, entityType: type }),
      hydrateNetworkSettingsOperationReceipts(userId),
    ]).then(
      ([value]) => {
        if (active) setLoaded({ identity, value });
      },
      () => {
        if (active) setLoaded({ identity, value: null });
      },
    );
    return () => {
      active = false;
    };
  }, [identity, scopeId, type, userId]);
  if (loaded?.identity !== identity)
    return (
      <div className="network-route-loading" role="status">
        <Spinner />
        <span>Открываем настройки…</span>
      </div>
    );
  const stored = loaded.value;
  const parsed =
    section === undefined
      ? null
      : type === 'chat'
        ? networkChatWorkspaceSectionSchema.safeParse(section)
        : networkChannelSettingsSectionSchema.safeParse(section);
  const recovered = stored
    ? resolveNetworkRouteOperation({
        userId,
        scopeId,
        entityType: stored.scope.entityType,
        section,
        requestedOperationId: operationId,
        receipts: listNetworkSettingsOperationReceipts(userId),
      })
    : { kind: 'none' as const };
  const operationUnavailable = recovered.kind === 'unavailable';
  if (
    !stored ||
    (parsed !== null && !parsed.success) ||
    stored.scope.entityType !== type ||
    operationUnavailable
  )
    return (
      <div className="network-route-error" role="alert">
        <h1>
          {operationUnavailable ? 'Операция не связана с этим выбором' : 'Выбор не сохранился'}
        </h1>
        <p>
          {operationUnavailable
            ? 'Откройте сохранённую операцию из раздела «Сетки».'
            : 'Откройте сетку и заново выберите сообщества.'}
        </p>
        <Link to="/networks">К сеткам</Link>
      </div>
    );
  const hubPath = `/networks/${type}/settings?${new URLSearchParams({ scope: scopeId })}`;
  const openSection = (
    nextSection: import('@maxim/contracts/network-settings-read').NetworkSettingsSection,
  ) =>
    requestNavigation(
      `/networks/${type}/settings/${nextSection}?${new URLSearchParams({ scope: scopeId })}`,
    );
  const scope = parsed?.success
    ? ({ ...stored.scope, initialSection: parsed.data } as NetworkSettingsEditorScope)
    : null;
  return (
    <NetworkSettingsOverview
      api={api}
      stored={stored}
      section={scope?.initialSection}
      onSectionChange={openSection}
    >
      {scope ? (
        <NetworkSettingsPage
          key={`${identity}:${scope.initialSection}:${operationId ?? ''}`}
          api={api}
          userId={userId}
          scopeId={scopeId}
          scope={scope}
          title={stored.title}
          returnTo={stored.returnTo}
          resumeOperationId={recovered.kind === 'resume' ? recovered.operationId : undefined}
          onClose={() => requestNavigation(hubPath, { replace: true })}
        />
      ) : null}
    </NetworkSettingsOverview>
  );
}
