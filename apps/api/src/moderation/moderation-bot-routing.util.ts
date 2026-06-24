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
