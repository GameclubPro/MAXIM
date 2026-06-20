import type { ManagedEntityOnboardingDiagnostics, ManagedEntityType } from '@maxim/contracts';
import type { ApiTransport } from './transport';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManagedEntityOnboardingDiagnostics(
  value: unknown,
): ManagedEntityOnboardingDiagnostics {
  if (
    !isRecord(value) ||
    (value.entityType !== 'chat' && value.entityType !== 'channel') ||
    typeof value.hasVisibleEntities !== 'boolean' ||
    !Array.isArray(value.recentSignals)
  ) {
    throw new Error('Invalid managed entity onboarding diagnostics');
  }

  const recentSignals = value.recentSignals.flatMap((item) => {
    if (
      !isRecord(item) ||
      (item.type !== 'recent_activity' &&
        item.type !== 'access_edge' &&
        item.type !== 'handshake') ||
      typeof item.chatId !== 'string' ||
      typeof item.status !== 'string'
    ) {
      return [];
    }
    const signalType: ManagedEntityOnboardingDiagnostics['recentSignals'][number]['type'] =
      item.type;

    return [
      {
        type: signalType,
        chatId: item.chatId,
        title: typeof item.title === 'string' && item.title.trim().length > 0 ? item.title : null,
        status: item.status,
        at: typeof item.at === 'string' && item.at.trim().length > 0 ? item.at : null,
      },
    ];
  });
  let lastHandshake: ManagedEntityOnboardingDiagnostics['lastHandshake'] = null;
  if (isRecord(value.lastHandshake)) {
    const status = value.lastHandshake.status;
    if (
      typeof value.lastHandshake.chatId === 'string' &&
      typeof value.lastHandshake.happenedAt === 'string' &&
      (status === 'connected' ||
        status === 'already_connected' ||
        status === 'bootstrapped_without_user' ||
        status === 'bot_denied' ||
        status === 'user_denied' ||
        status === 'rate_limited' ||
        status === 'failed')
    ) {
      lastHandshake = {
        chatId: value.lastHandshake.chatId,
        title:
          typeof value.lastHandshake.title === 'string' &&
          value.lastHandshake.title.trim().length > 0
            ? value.lastHandshake.title
            : null,
        status,
        reason:
          typeof value.lastHandshake.reason === 'string' &&
          value.lastHandshake.reason.trim().length > 0
            ? value.lastHandshake.reason
            : null,
        happenedAt: value.lastHandshake.happenedAt,
      };
    }
  }

  return {
    entityType: value.entityType,
    hasVisibleEntities: value.hasVisibleEntities,
    recentSignals,
    lastHandshake,
  };
}

export async function getManagedEntityOnboardingDiagnostics(
  api: ApiTransport,
  entityType: ManagedEntityType,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedEntityOnboardingDiagnostics> {
  const response = await api.request(
    `/managed-entities/${encodeURIComponent(entityType)}/onboarding-diagnostics`,
    {
      signal: options.signal,
    },
  );
  return parseManagedEntityOnboardingDiagnostics(response);
}
