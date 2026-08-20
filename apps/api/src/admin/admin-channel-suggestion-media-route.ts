import { ServiceUnavailableException } from '@nestjs/common';

import type { ChannelSuggestionImageAsset } from './admin.service.support';

export type ChannelSuggestionPublicationBotAssignment = {
  botId: string | undefined;
  routeResolved: boolean;
  candidateBotIds: string[];
};

export type ChannelSuggestionMediaRouteFailureReason =
  | 'legacy_route'
  | 'missing_delivery_bot'
  | 'ambiguous_delivery_bot'
  | 'delivery_bot_not_routable';

export async function resolveChannelSuggestionMediaPublicationBotId(params: {
  payload: Record<string, unknown>;
  images: ChannelSuggestionImageAsset[];
  assignment: ChannelSuggestionPublicationBotAssignment;
  loadSentDeliveryBotIds: () => Promise<readonly (string | null | undefined)[]>;
  onUnavailable?: (reason: ChannelSuggestionMediaRouteFailureReason) => void;
}): Promise<string | undefined> {
  const hasBotScopedToken =
    Boolean(readPayloadToken(params.payload.mediaPayload)) ||
    params.images.some((image) => Boolean(readPayloadToken(image.payload)));
  if (!hasBotScopedToken) {
    return params.assignment.botId;
  }

  if (!params.assignment.routeResolved) {
    throwUnavailable(params, 'legacy_route');
  }

  const deliveryBotIds = Array.from(
    new Set(
      (await params.loadSentDeliveryBotIds())
        .map((botId) => readNonEmptyString(botId))
        .filter((botId): botId is string => Boolean(botId)),
    ),
  );
  if (deliveryBotIds.length !== 1) {
    throwUnavailable(
      params,
      deliveryBotIds.length === 0 ? 'missing_delivery_bot' : 'ambiguous_delivery_bot',
    );
  }

  const deliveryBotId = deliveryBotIds[0];
  const routeCandidateBotIds = new Set(
    params.assignment.candidateBotIds
      .map((botId) => readNonEmptyString(botId))
      .filter((botId): botId is string => Boolean(botId)),
  );
  if (!routeCandidateBotIds.has(deliveryBotId)) {
    throwUnavailable(params, 'delivery_bot_not_routable');
  }

  return deliveryBotId;
}

function throwUnavailable(
  params: { onUnavailable?: (reason: ChannelSuggestionMediaRouteFailureReason) => void },
  reason: ChannelSuggestionMediaRouteFailureReason,
): never {
  params.onUnavailable?.(reason);
  throw new ServiceUnavailableException(
    'Медиа предложки временно недоступно для безопасной публикации. Попробуйте позже.',
  );
}

function readPayloadToken(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return readNonEmptyString((value as Record<string, unknown>).token);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
