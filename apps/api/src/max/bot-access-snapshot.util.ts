import { createHash } from 'crypto';
import { ChatBotAccessState, type Prisma } from '../prisma/prisma-client';

const DEFAULT_BOT_ACCESS_TTL_MS = 15 * 60 * 1_000;

export type BotAccessSnapshotInput = {
  isAdmin: boolean;
  isOwner: boolean;
  permissions?: readonly string[];
  permissionsKnown?: boolean;
} | null;

export type BotAccessSnapshotPersistence = {
  permissionsSnapshot: Prisma.InputJsonValue;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date;
  botAccessExpiresAt: Date;
  botAccessSource: string;
  botAccessLastErrorCode: string | null;
  permissionsHash: string;
};

export function buildBotAccessSnapshotPersistence(
  access: BotAccessSnapshotInput,
  options: {
    source: string;
    now?: Date;
    ttlMs?: number;
    lastErrorCode?: string | null;
  },
): BotAccessSnapshotPersistence {
  const now = options.now ?? new Date();
  const permissions = normalizePermissions(access?.permissions ?? []);
  const permissionsSnapshot = {
    checkedAt: now.toISOString(),
    isAdmin: access?.isAdmin === true,
    isOwner: access?.isOwner === true,
    permissions,
    permissionsKnown: access?.permissionsKnown === true,
  } satisfies Prisma.InputJsonObject;

  return {
    permissionsSnapshot,
    botAccessState: resolveBotAccessState(access),
    botAccessCheckedAt: now,
    botAccessExpiresAt: new Date(now.getTime() + (options.ttlMs ?? DEFAULT_BOT_ACCESS_TTL_MS)),
    botAccessSource: options.source,
    botAccessLastErrorCode: options.lastErrorCode ?? null,
    permissionsHash: hashPermissionsSnapshot(permissionsSnapshot),
  };
}

export function normalizePermissions(permissions: readonly string[]): string[] {
  return Array.from(
    new Set(
      permissions
        .map((permission) => permission.trim())
        .filter((permission) => permission.length > 0),
    ),
  );
}

function resolveBotAccessState(access: BotAccessSnapshotInput): ChatBotAccessState {
  if (!access) {
    return ChatBotAccessState.DENIED;
  }
  if (access.isOwner === true) {
    return ChatBotAccessState.CONFIRMED_OWNER;
  }
  if (access.isAdmin === true) {
    return ChatBotAccessState.CONFIRMED_ADMIN;
  }
  return ChatBotAccessState.CONFIRMED_MEMBER;
}

function hashPermissionsSnapshot(snapshot: Prisma.InputJsonObject): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
