import type { MaxUpdate } from '@maxim/contracts';
import type {
  MaxBotLinkService,
  MaxBotRoute,
  MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import type { MaxBotContextService } from '../max/max-bot-context.service';

export type ModerationBotRoutingDependencies = {
  maxBotLinkService?: MaxBotLinkService;
  maxBotContextService?: MaxBotContextService;
};

export type ModerationActionBotAction = 'delete_message' | 'edit_message' | 'moderate_member';

type ModerationActionBotResolver = {
  resolveBotIdsForModerationAction?: (params: {
    chatId: string;
    action: ModerationActionBotAction;
    fallbackToPrimary?: boolean;
  }) => Promise<string[]>;
  resolveBotIdForModerationAction?: (params: {
    chatId: string;
    action: ModerationActionBotAction;
    fallbackToPrimary?: boolean;
  }) => Promise<string | null>;
};

export function readExecutionOwnerBotId(update: MaxUpdate): string | null {
  const value = (
    update as MaxUpdate & {
      executionOwnerBotId?: unknown;
    }
  ).executionOwnerBotId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveUnifiedBotRoute(
  deps: Pick<ModerationBotRoutingDependencies, 'maxBotLinkService'>,
  request: MaxBotRouteRequest,
): Promise<MaxBotRoute | null> {
  const routeResolver = deps.maxBotLinkService as unknown as {
    resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    resolveBotRoutes?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
  };
  if (
    request.purpose === 'moderation_action' &&
    typeof routeResolver?.resolveBotRoutes === 'function'
  ) {
    return routeResolver.resolveBotRoutes(request);
  }

  if (typeof routeResolver?.resolveBotRoute === 'function') {
    return routeResolver.resolveBotRoute(request);
  }

  return null;
}

export async function resolveChatReadBotId(
  deps: Pick<ModerationBotRoutingDependencies, 'maxBotLinkService'>,
  chatId: string,
): Promise<string | null> {
  const route = await resolveUnifiedBotRoute(deps, {
    purpose: 'read',
    chatId,
  });
  if (route?.botId) {
    return route.botId;
  }

  return (
    (await deps.maxBotLinkService?.resolveBotIdForRead?.({ chatId })) ??
    (await deps.maxBotLinkService?.resolveBotId?.({ chatId })) ??
    null
  );
}

export async function resolveAutoAttachBotId(
  deps: ModerationBotRoutingDependencies,
  chatId: string,
  source: 'webhook' | 'poll',
): Promise<string | null> {
  const activeBotId = deps.maxBotContextService?.getActiveBotId() ?? null;
  if (typeof activeBotId === 'string' && activeBotId.trim().length > 0) {
    return activeBotId.trim();
  }

  if (source === 'poll') {
    const scanBotRoute = await resolveUnifiedBotRoute(deps, {
      purpose: 'capability',
      chatId,
      capability: 'background_scans',
      fallbackToPrimary: true,
    });
    const scanBotId =
      scanBotRoute?.botId ??
      (await deps.maxBotLinkService?.resolveBotIdForCapability?.({
        chatId,
        capability: 'background_scans',
      })) ??
      null;
    if (typeof scanBotId === 'string' && scanBotId.trim().length > 0) {
      return scanBotId.trim();
    }
  }

  return await resolveChatReadBotId(deps, chatId);
}

export async function resolveNightModeTransitionBotId(
  deps: Pick<ModerationBotRoutingDependencies, 'maxBotLinkService'>,
  chatId: string,
): Promise<string | null> {
  const sendRoute = await resolveUnifiedBotRoute(deps, {
    purpose: 'send_message',
    chatId,
    fallbackToPrimary: true,
  });
  if (typeof sendRoute?.botId === 'string' && sendRoute.botId.trim().length > 0) {
    return sendRoute.botId.trim();
  }
  if (
    sendRoute?.purpose === 'send_message' &&
    (sendRoute.quarantinedCandidateBotIds?.length ?? 0) > 0
  ) {
    return null;
  }

  const route = await resolveUnifiedBotRoute(deps, {
    purpose: 'capability',
    chatId,
    capability: 'background_scans',
    fallbackToPrimary: true,
  });
  const botId =
    route?.botId ??
    (await deps.maxBotLinkService?.resolveBotIdForCapability?.({
      chatId,
      capability: 'background_scans',
    })) ??
    (await resolveChatReadBotId(deps, chatId));

  return typeof botId === 'string' && botId.trim().length > 0 ? botId.trim() : null;
}

export async function resolveModerationActionBotIds(
  deps: Pick<ModerationBotRoutingDependencies, 'maxBotLinkService'>,
  params: {
    chatId: string;
    action: ModerationActionBotAction;
    explicitBotId?: string | null;
  },
): Promise<Array<string | null>> {
  const explicitBotId =
    typeof params.explicitBotId === 'string' && params.explicitBotId.trim().length > 0
      ? params.explicitBotId.trim()
      : null;
  if (explicitBotId) {
    return [explicitBotId];
  }

  const route = await resolveUnifiedBotRoute(deps, {
    purpose: 'moderation_action',
    chatId: params.chatId,
    action: params.action,
    fallbackToPrimary: true,
  });
  if (route) {
    return normalizeBotIdList(route.candidateBotIds);
  }

  const maxBotLinkService = deps.maxBotLinkService as unknown as ModerationActionBotResolver;

  if (typeof maxBotLinkService?.resolveBotIdsForModerationAction === 'function') {
    const resolvedBotIds = await maxBotLinkService.resolveBotIdsForModerationAction({
      chatId: params.chatId,
      action: params.action,
      fallbackToPrimary: true,
    });
    return normalizeBotIdList(resolvedBotIds);
  }

  if (typeof maxBotLinkService?.resolveBotIdForModerationAction === 'function') {
    const resolvedBotId = await maxBotLinkService.resolveBotIdForModerationAction({
      chatId: params.chatId,
      action: params.action,
      fallbackToPrimary: true,
    });
    return resolvedBotId ? [resolvedBotId] : [];
  }

  return [null];
}

function normalizeBotIdList(botIds: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      botIds
        .map((botId) => (typeof botId === 'string' ? botId.trim() : ''))
        .filter((botId) => botId.length > 0),
    ),
  );
}
