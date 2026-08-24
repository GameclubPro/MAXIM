import type { ChannelSuggestionDeliverySummary } from '@maxim/contracts';
import { hasChannelSuggestionBotScopedMediaToken } from './admin-channel-suggestion-media-route';
import type { ChannelSuggestionDeliveryInput } from './admin.service.support';

export type ChannelSuggestionPrivateDeliveryRoute = {
  botId: string;
  privateChatId: string;
};

export type ChannelSuggestionPrivateDeliveryRoutePlan = {
  botIds: string[];
  failureBotId: string | null;
  routeError: unknown | null;
};

export type ChannelSuggestionPrivateDeliveryLedgerRoute = {
  botId: string | null;
  privateChatId: string | null;
};

export type ChannelSuggestionDeliveryLedgerEvidence = {
  adminUserId: string;
  status: string;
  terminal: boolean;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  retryable: boolean;
};

export function selectRetryableLogicalDeliveryRows<
  T extends { adminUserId: string; status: string },
>(rows: readonly T[], isRetryable: (row: T) => boolean): T[] {
  const rowsByAdmin = new Map<string, T[]>();
  for (const row of rows) {
    const adminUserId = readNonEmptyString(row.adminUserId);
    if (!adminUserId) continue;
    const group = rowsByAdmin.get(adminUserId) ?? [];
    group.push(row);
    rowsByAdmin.set(adminUserId, group);
  }

  const selected: T[] = [];
  for (const group of rowsByAdmin.values()) {
    if (group.some((row) => ['SENT', 'AMBIGUOUS', 'SENDING'].includes(row.status))) continue;
    const retryable = group
      .filter(isRetryable)
      .sort(
        (left, right) => Number(right.status === 'PENDING') - Number(left.status === 'PENDING'),
      )[0];
    if (retryable) selected.push(retryable);
  }
  return selected;
}

export function buildChannelSuggestionDeliverySnapshot(
  rows: readonly ChannelSuggestionDeliveryLedgerEvidence[],
): ChannelSuggestionDeliverySummary {
  const evidenceByAdmin = new Map<string, 'sent' | 'uncertain' | 'pending' | 'unreachable'>();
  const priority = { unreachable: 1, pending: 2, uncertain: 3, sent: 4 } as const;
  for (const row of rows) {
    const adminUserId = readNonEmptyString(row.adminUserId);
    if (!adminUserId) continue;
    const evidence = classifyDeliveryEvidence(row);
    const current = evidenceByAdmin.get(adminUserId);
    if (!current || priority[evidence] > priority[current])
      evidenceByAdmin.set(adminUserId, evidence);
  }

  const evidence = [...evidenceByAdmin.values()];
  const deliveredCount = evidence.filter((value) => value === 'sent').length;
  const pendingCount = evidence.filter((value) => value === 'pending').length;
  const unreachableCount = evidence.filter((value) => value === 'unreachable').length;
  const targetCount = evidence.length;
  const state: ChannelSuggestionDeliverySummary['state'] =
    deliveredCount > 0
      ? deliveredCount === targetCount
        ? 'delivered'
        : 'partially_delivered'
      : pendingCount > 0
        ? 'queued'
        : targetCount === 0 || unreachableCount === targetCount
          ? 'no_reachable_editor'
          : 'uncertain';
  return { state, deliveredCount, targetCount, pendingCount, unreachableCount };
}

export function createChannelSuggestionDeliveryRouteError(
  status: number,
  code: string,
  message: string,
): unknown {
  return {
    response: {
      status,
      data: { code, message },
    },
  };
}

export function resolveChannelSuggestionPrivateDeliveryRoutePlan(params: {
  suggestion: ChannelSuggestionDeliveryInput;
  preferredBotId?: string | null;
  actionableBotIds: readonly string[] | null;
}): ChannelSuggestionPrivateDeliveryRoutePlan {
  const preferred = readNonEmptyString(params.preferredBotId);
  const actionableBots = params.actionableBotIds
    ? uniqueNonEmptyStrings(params.actionableBotIds)
    : null;
  const actionableBotIds = actionableBots ? new Set(actionableBots) : null;
  const hasBotScopedMedia = hasChannelSuggestionBotScopedMediaToken(
    { mediaPayload: params.suggestion.mediaPayload },
    params.suggestion.images ?? [],
  );

  if (hasBotScopedMedia) {
    const mediaBotId = readNonEmptyString(params.suggestion.mediaBotId);
    if (!mediaBotId) {
      return failedPlan(
        preferred,
        409,
        'suggestion.media.provenance.unknown',
        'bot-scoped suggestion media has no trusted upload bot provenance',
      );
    }
    if (actionableBotIds && !actionableBotIds.has(mediaBotId)) {
      return failedPlan(
        mediaBotId,
        503,
        'suggestion.delivery.no_actionable_bot',
        'the suggestion media upload bot is not actionable',
      );
    }
    return { botIds: [mediaBotId], failureBotId: mediaBotId, routeError: null };
  }

  const botIds = uniqueNonEmptyStrings([preferred, ...(actionableBots ?? [])]).filter(
    (botId) => !actionableBotIds || actionableBotIds.has(botId),
  );
  if (botIds.length === 0) {
    return failedPlan(
      preferred,
      503,
      'suggestion.delivery.no_actionable_bot',
      'no actionable suggestion delivery bot is currently available',
    );
  }
  return {
    botIds,
    failureBotId: preferred ?? botIds[0] ?? null,
    routeError: null,
  };
}

export function mergeChannelSuggestionPrivateDeliveryRoutes(params: {
  ledgerRoute: ChannelSuggestionPrivateDeliveryLedgerRoute;
  discoveredRoutes: readonly ChannelSuggestionPrivateDeliveryRoute[];
  allowedBotIds: readonly string[];
}): ChannelSuggestionPrivateDeliveryRoute[] {
  const allowed = new Set(uniqueNonEmptyStrings(params.allowedBotIds));
  const routes: ChannelSuggestionPrivateDeliveryRoute[] = [];
  const seen = new Set<string>();
  const append = (route: ChannelSuggestionPrivateDeliveryLedgerRoute) => {
    const botId = readNonEmptyString(route.botId);
    const privateChatId = readNonEmptyString(route.privateChatId);
    if (!botId || !privateChatId || !allowed.has(botId)) return;
    const key = `${botId}\u0000${privateChatId}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ botId, privateChatId });
  };

  append(params.ledgerRoute);
  for (const route of params.discoveredRoutes) append(route);
  return routes;
}

function failedPlan(
  failureBotId: string | null,
  status: number,
  code: string,
  message: string,
): ChannelSuggestionPrivateDeliveryRoutePlan {
  return {
    botIds: [],
    failureBotId,
    routeError: createChannelSuggestionDeliveryRouteError(status, code, message),
  };
}

function classifyDeliveryEvidence(
  row: ChannelSuggestionDeliveryLedgerEvidence,
): 'sent' | 'uncertain' | 'pending' | 'unreachable' {
  if (row.status === 'SENT') return 'sent';
  if (row.status === 'AMBIGUOUS') return 'uncertain';
  if (row.status === 'PENDING' || row.status === 'SENDING' || row.retryable) return 'pending';
  const code = readNonEmptyString(row.lastErrorCode)?.toLowerCase() ?? '';
  const explicitUnavailable = [
    'suggestion.delivery.dialog_unavailable',
    'suggestion.delivery.editor_removed',
    'suggestion.delivery.no_reachable_dialog',
  ].includes(code);
  const legacyUnavailable =
    !code.startsWith('suggestion.delivery.') &&
    (row.lastStatusCode === 403 ||
      row.lastStatusCode === 404 ||
      ['access.denied', 'chat.denied', 'chat.not.found', 'dialog.not.found'].includes(code));
  return row.terminal && (explicitUnavailable || legacyUnavailable) ? 'unreachable' : 'uncertain';
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => readNonEmptyString(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
