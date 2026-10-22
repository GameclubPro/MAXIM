import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiTransport } from '../lib/api/transport';
import { GlassCard } from '../components/ui/glass-card';
import { SettingsOverviewSearch } from '../components/ui/settings-overview-search';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { getNetworkSettingsSections } from './settings/settings-workspace-sections';
import type { NetworkSettingsSection } from '@maxim/contracts/network-settings-read';
import type { StoredNetworkSettingsScope } from '../lib/network-settings-workspace-state';
import { useManagedEntityNavigation } from '../lib/managed-entity-navigation';
import { useNativeBackHandler } from '../lib/native-back';
import {
  NetworkWorkspaceHeader,
  NetworkWorkspaceTabs,
} from '../features/networks/network-workspace-header';
import { useHomeEntityNetworkCatalogue } from '../lib/home-entity-networks-context';
import { buildNetworkRoute, readNetworkRoute } from '../features/networks/network-route-state';
import '../components/ui/managed-entity-workspace-tokens.css';
import '../styles/moderation-catalogue-steel.css';
import './network-settings-page.css';
import '../styles/settings-home-compact.css';
import '../styles/settings-home-route-polish.css';
import './settings-page.css';
import '../styles/settings-tile-grid.css';
import '../styles/settings-steel.css';
import '../components/ui/managed-entity-settings-header.css';

export function NetworkSettingsOverview({
  api,
  stored,
  section,
  onSectionChange,
  children,
}: {
  api: ApiTransport;
  stored: StoredNetworkSettingsScope;
  section?: NetworkSettingsSection;
  onSectionChange: (section: NetworkSettingsSection) => void;
  children?: ReactNode;
}) {
  const { requestNavigation } = useManagedEntityNavigation();
  const { entityType, target } = stored.scope;
  const catalogue = useHomeEntityNetworkCatalogue(entityType);
  const card =
    target.mode === 'category'
      ? catalogue.cards.find((item) => item.favoriteType === target.favoriteType)
      : undefined;
  const route = {
    ...readNetworkRoute(new URL(stored.returnTo, 'https://miniapp.invalid').search),
    entityType,
    favoriteType: target.mode === 'category' ? target.favoriteType : null,
  };

  const advertising = useQuery({
    queryKey: ['advertising-placement-capability', stored.userId],
    enabled: entityType === 'chat',
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const value = await api.request('/advertising-placement/capability');
      return {
        available:
          typeof value === 'object' &&
          value !== null &&
          'available' in value &&
          value.available === true,
      };
    },
  });
  useEffect(() => {
    const className =
      entityType === 'chat' ? 'settings-home-page-open' : 'channel-settings-page-open';
    document.body.classList.add(className, 'network-settings-page-open');
    return () => document.body.classList.remove(className, 'network-settings-page-open');
  }, [entityType]);
  useNativeBackHandler(
    () => {
      requestNavigation(stored.returnTo);
      return true;
    },
    { enabled: !section, priority: 100 },
  );
  const isChat = entityType === 'chat';
  const containerId = 'network-settings-overview';
  const sections = getNetworkSettingsSections(entityType).filter(
    (entry) => entry.overview !== false,
  );
  const search = (
    <SettingsOverviewSearch
      containerId={containerId}
      entrySelector={isChat ? '.settings-home-entry' : '.channel-settings-card'}
      groupSelector={isChat ? '.settings-home-group-head' : undefined}
    />
  );
  const entries = sections.map((entry) => {
    if (isChat && entry.section === 'advertising' && !advertising.data?.available) return null;
    const head = (
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title={entry.title}
          icon={entry.icon}
          tone={entry.tone}
          open={section === entry.section}
          controls={'network-settings-' + entityType + '-' + entry.section}
          onClick={() => onSectionChange(entry.section)}
        />
      </div>
    );
    if (isChat && entry.plainEntry)
      return (
        <section
          key={entry.section}
          className="settings-section settings-home-entry settings-home-entry--list"
          style={{ order: entry.order }}
          aria-label={entry.title}
        >
          {head}
        </section>
      );
    return (
      <GlassCard
        key={entry.section}
        className={
          isChat
            ? `settings-section settings-home-entry${entry.entryVariant === 'plain' ? '' : ' settings-home-entry--' + (entry.entryVariant ?? 'list')}${entry.entryClassName ? ' ' + entry.entryClassName : ''} stagger-in`
            : 'channel-settings-card' +
              (entry.section === 'postSignature' ? ' channel-post-signature-entry' : '')
        }
        style={{ order: entry.order }}
        elevated={!isChat}
      >
        {head}
      </GlassCard>
    );
  });
  return (
    <div
      id={isChat ? undefined : containerId}
      className={
        (isChat ? 'page-stack page-enter' : 'channel-settings-screen page-enter') +
        ' network-settings-workspace'
      }
      data-managed-entity-workspace={isChat ? 'chat-settings' : 'channel-settings'}
      data-network-settings-overview
    >
      <NetworkWorkspaceHeader
        title={stored.title}
        entityType={entityType}
        favoriteType={target.mode === 'category' ? target.favoriteType : undefined}
        count={target.mode === 'selected' ? target.entityIds.length : card?.entityCount}
        backLabel="Назад к сетке"
        onBack={() => requestNavigation(stored.returnTo)}
        onPick={(type, favoriteType) =>
          requestNavigation(
            buildNetworkRoute({ ...route, entityType: type, favoriteType, tab: 'overview' }),
          )
        }
      />
      <NetworkWorkspaceTabs
        value="settings"
        onChange={(tab) => {
          if (tab !== 'settings') requestNavigation(buildNetworkRoute({ ...route, tab }));
        }}
      />
      {card?.entityCount === 0 ? (
        <p className="network-settings-editor__status">
          В сетке пока нет сообществ. Добавьте их в разделе «Состав».
        </p>
      ) : null}
      {card?.entityCount === 0 ? null : isChat ? (
        <section
          className="settings-sections settings-sections--chat-home"
          aria-label="Настройки сетки чатов"
        >
          {search}
          <div id={containerId} className="settings-sections-shell">
            <div className="settings-home-group-head stagger-in" style={{ order: 10 }}>
              <h2 className="settings-home-group-head__title">Защита</h2>
            </div>
            <div className="settings-home-group-head stagger-in" style={{ order: 20 }}>
              <h2 className="settings-home-group-head__title">Контент</h2>
            </div>
            {card?.entityCount !== 0 ? entries : null}
          </div>
        </section>
      ) : (
        <>
          {search}
          {card?.entityCount !== 0 ? entries : null}
        </>
      )}
      {children}
    </div>
  );
}
