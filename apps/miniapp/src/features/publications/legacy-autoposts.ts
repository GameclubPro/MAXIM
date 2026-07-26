import type { ManagedAutopostHubRuleSummary } from '@maxim/contracts';
import type { LegacyPublicationSummary } from '@maxim/contracts/publication';
import type { BroadcastWorkspaceView } from '../../components/broadcast-studio-workspace';

export type LegacyBroadcastEditorTarget = {
  kind: 'autopost' | 'broadcast';
  id: string;
};

type LegacyPublicationNavigationState = {
  legacyPublicationReturnTo: string;
};

export function buildLegacyAutopostSettingsPath(
  rule: Pick<ManagedAutopostHubRuleSummary, 'entityType' | 'sourceChatId'>,
): string {
  const entityPath = rule.entityType === 'channel' ? 'channel' : 'chat';
  return `/${entityPath}/${encodeURIComponent(
    rule.sourceChatId,
  )}/settings?focus=broadcast&workspace=autoposts`;
}

export function buildLegacyPublicationSettingsPath(
  item: Pick<LegacyPublicationSummary, 'id' | 'kind'> & {
    source: Pick<LegacyPublicationSummary['source'], 'chatId' | 'entityType'>;
  },
): string {
  const entityPath = item.source.entityType === 'channel' ? 'channel' : 'chat';
  const params = new URLSearchParams({
    focus: 'broadcast',
    legacyKind: item.kind,
    legacyId: item.id,
  });
  return `/${entityPath}/${encodeURIComponent(item.source.chatId)}/settings?${params.toString()}`;
}

export function buildLegacyPublicationNavigationState(
  pathname: string,
  search: string,
): LegacyPublicationNavigationState {
  return { legacyPublicationReturnTo: `${pathname}${search}` };
}

export function resolveLegacyPublicationReturnPath(state: unknown): string | null {
  if (!state || typeof state !== 'object') {
    return null;
  }
  const candidate = (state as Partial<LegacyPublicationNavigationState>).legacyPublicationReturnTo;
  if (typeof candidate !== 'string') {
    return null;
  }
  try {
    const baseUrl = new URL('https://miniapp.invalid');
    const parsed = new URL(candidate, baseUrl);
    if (
      parsed.origin !== baseUrl.origin ||
      parsed.pathname !== '/publications' ||
      parsed.searchParams.get('legacy') !== '1' ||
      parsed.hash
    ) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function canOpenLegacyPublication(item: Pick<LegacyPublicationSummary, 'kind' | 'status'>) {
  return (
    item.kind === 'broadcast' &&
    (item.status === 'ACTIVE' || item.status === 'PARTIAL' || item.status === 'FAILED')
  );
}

export function resolveLegacyBroadcastEditorTarget(
  search: string,
): LegacyBroadcastEditorTarget | null {
  const params = new URLSearchParams(search);
  if (params.get('focus') !== 'broadcast' || params.has('handoff') || params.has('workspace')) {
    return null;
  }

  const kindValues = params.getAll('legacyKind');
  const idValues = params.getAll('legacyId');
  if (kindValues.length !== 1 || idValues.length !== 1) {
    return null;
  }

  const kind = kindValues[0];
  const id = idValues[0]?.trim() ?? '';
  if ((kind !== 'autopost' && kind !== 'broadcast') || !id || id.length > 256) {
    return null;
  }

  return { kind, id };
}

export function resolveRequestedBroadcastWorkspace(search: string): BroadcastWorkspaceView {
  const params = new URLSearchParams(search);
  return params.get('focus') === 'broadcast' && params.get('workspace') === 'autoposts'
    ? 'autoposts'
    : 'compose';
}
