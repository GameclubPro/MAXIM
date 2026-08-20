import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import {
  isFreshMembershipAccessSnapshot,
  normalizeMembershipAccessSnapshot,
} from './max-bot-access-policy.util';

export const MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export type ManagedEntityBotMembershipIdentityRow = {
  chatId?: string | null;
  botId?: string | null;
  status?: ChatBotMembershipStatus | string | null;
};

export type ManagedEntityBotMembershipAccessRow = ManagedEntityBotMembershipIdentityRow & {
  permissionsSnapshot?: unknown;
  botAccessState?: ChatBotAccessState | string | null;
  botAccessExpiresAt?: Date | string | null;
};

export type ManagedEntityBotAccessEdgeRow = {
  botId?: string | null;
  state?: ManagedEntityAccessState | string | null;
  checkedAt?: Date | string | null;
  expiresAt?: Date | string | null;
};

export function collectActiveManagedEntityBotMembershipIds(
  rows: readonly ManagedEntityBotMembershipIdentityRow[],
  options: { isRuntimeBotId?: (botId: string) => boolean } = {},
): Set<string> {
  const botIds = new Set<string>();
  for (const row of rows) {
    const botId = normalizeManagedEntityAccessIdentity(row.botId);
    if (!botId || row.status !== ChatBotMembershipStatus.ACTIVE) {
      continue;
    }
    if (options.isRuntimeBotId && !options.isRuntimeBotId(botId)) {
      continue;
    }
    botIds.add(botId);
  }
  return botIds;
}

export function collectActiveManagedEntityBotMembershipIdsByChat(
  rows: readonly ManagedEntityBotMembershipIdentityRow[],
  options: { isRuntimeBotId?: (botId: string) => boolean } = {},
): Map<string, Set<string>> {
  const botIdsByChatId = new Map<string, Set<string>>();
  for (const row of rows) {
    const chatId = normalizeManagedEntityAccessIdentity(row.chatId);
    const botId = normalizeManagedEntityAccessIdentity(row.botId);
    if (!chatId || !botId || row.status !== ChatBotMembershipStatus.ACTIVE) {
      continue;
    }
    if (options.isRuntimeBotId && !options.isRuntimeBotId(botId)) {
      continue;
    }
    const botIds = botIdsByChatId.get(chatId) ?? new Set<string>();
    botIds.add(botId);
    botIdsByChatId.set(chatId, botIds);
  }
  return botIdsByChatId;
}

export function managedEntityBotMembershipHasFreshConfirmedAccess(
  membership: ManagedEntityBotMembershipAccessRow | null | undefined,
  options: { nowMs?: number } = {},
): boolean {
  if (membership?.status !== ChatBotMembershipStatus.ACTIVE) {
    return false;
  }

  const nowMs = resolveNowMs(options.nowMs);
  const accessState = membership.botAccessState;
  if (
    accessState === ChatBotAccessState.CONFIRMED_ADMIN ||
    accessState === ChatBotAccessState.CONFIRMED_OWNER
  ) {
    if (membership.botAccessExpiresAt !== null && membership.botAccessExpiresAt !== undefined) {
      return readTimestampMs(membership.botAccessExpiresAt) > nowMs;
    }
  } else if (
    accessState !== null &&
    accessState !== undefined &&
    accessState !== ChatBotAccessState.UNKNOWN
  ) {
    return false;
  }

  const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
  return Boolean(
    snapshot &&
    isFreshMembershipAccessSnapshot(snapshot, { nowMs }) &&
    (snapshot.isAdmin || snapshot.isOwner),
  );
}

export function managedEntityBotMembershipAllowsFreshGrantedEdge(
  membership: ManagedEntityBotMembershipAccessRow | null | undefined,
): boolean {
  if (membership?.status !== ChatBotMembershipStatus.ACTIVE) {
    return false;
  }

  switch (membership.botAccessState) {
    case null:
    case undefined:
    case ChatBotAccessState.UNKNOWN:
    case ChatBotAccessState.CONFIRMED_ADMIN:
    case ChatBotAccessState.CONFIRMED_OWNER:
      return true;
    default:
      return false;
  }
}

export function managedEntityBotAccessEdgeIsFreshGranted(
  edge: ManagedEntityBotAccessEdgeRow | null | undefined,
  options: { nowMs?: number; legacyGraceMs?: number } = {},
): boolean {
  if (edge?.state !== ManagedEntityAccessState.GRANTED) {
    return false;
  }

  const nowMs = resolveNowMs(options.nowMs);
  if (edge.expiresAt !== null && edge.expiresAt !== undefined) {
    return readTimestampMs(edge.expiresAt) > nowMs;
  }

  const checkedAtMs = readTimestampMs(edge.checkedAt);
  const legacyGraceMs =
    typeof options.legacyGraceMs === 'number' && Number.isFinite(options.legacyGraceMs)
      ? Math.max(0, Math.trunc(options.legacyGraceMs))
      : MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS;
  return checkedAtMs + legacyGraceMs > nowMs;
}

export function hasFreshActionableManagedEntityBotAccess(params: {
  memberships: readonly ManagedEntityBotMembershipAccessRow[];
  accessEdges?: readonly ManagedEntityBotAccessEdgeRow[];
  isActionableBotId?: (botId: string) => boolean;
  nowMs?: number;
}): boolean {
  const activeBotIds = collectActiveManagedEntityBotMembershipIds(params.memberships, {
    isRuntimeBotId: params.isActionableBotId,
  });
  if (activeBotIds.size === 0) {
    return false;
  }

  const nowMs = resolveNowMs(params.nowMs);
  if (
    params.accessEdges?.some((edge) => {
      const botId = normalizeManagedEntityAccessIdentity(edge.botId);
      return (
        Boolean(botId && activeBotIds.has(botId)) &&
        params.memberships.some(
          (membership) =>
            normalizeManagedEntityAccessIdentity(membership.botId) === botId &&
            managedEntityBotMembershipAllowsFreshGrantedEdge(membership),
        ) &&
        managedEntityBotAccessEdgeIsFreshGranted(edge, { nowMs })
      );
    })
  ) {
    return true;
  }

  return params.memberships.some((membership) => {
    const botId = normalizeManagedEntityAccessIdentity(membership.botId);
    return (
      Boolean(botId && activeBotIds.has(botId)) &&
      managedEntityBotMembershipHasFreshConfirmedAccess(membership, { nowMs })
    );
  });
}

function normalizeManagedEntityAccessIdentity(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTimestampMs(value: Date | string | null | undefined): number {
  return value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : NaN;
}

function resolveNowMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}
