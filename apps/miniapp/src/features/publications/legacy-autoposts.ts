import type { ManagedAutopostHubRuleSummary } from '@maxim/contracts';
import type { BroadcastWorkspaceView } from '../../components/broadcast-studio-workspace';

export function buildLegacyAutopostSettingsPath(
  rule: Pick<ManagedAutopostHubRuleSummary, 'entityType' | 'sourceChatId'>,
): string {
  const entityPath = rule.entityType === 'channel' ? 'channel' : 'chat';
  return `/${entityPath}/${encodeURIComponent(
    rule.sourceChatId,
  )}/settings?focus=broadcast&workspace=autoposts`;
}

export function resolveRequestedBroadcastWorkspace(search: string): BroadcastWorkspaceView {
  const params = new URLSearchParams(search);
  return params.get('focus') === 'broadcast' && params.get('workspace') === 'autoposts'
    ? 'autoposts'
    : 'compose';
}
