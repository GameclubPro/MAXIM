import { ChannelSuggestionAdminDeliveryStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export const CHANNEL_SUGGESTION_ADMIN_DELIVERY_DEFAULT_BOT_KEY = '__default__';
export const CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE = 'suggestion.delivery.pre_dispatch';
export const CHANNEL_SUGGESTION_DELIVERY_DISPATCH_STARTED_CODE =
  'suggestion.delivery.dispatch_started';

export type ChannelSuggestionPreclaimFailure = {
  message: string;
  status: number | null;
  code: string | null;
  terminal: boolean;
  recoverable: boolean;
};

type RetryableChannelSuggestionEditorRow = {
  id: string;
  adminUserId: string;
};

type ChannelSuggestionEditorAccess = {
  isAdmin: boolean;
  isOwner: boolean;
};

export async function persistChannelSuggestionPreclaimFailure(params: {
  prisma: PrismaService;
  rowIds: readonly string[];
  failure: ChannelSuggestionPreclaimFailure;
  route?: { privateChatId: string | null; botId: string | null };
  incrementAttemptCount?: boolean;
}): Promise<number> {
  const rowIds = Array.from(new Set(params.rowIds.map((id) => id.trim()).filter(Boolean)));
  if (rowIds.length === 0) return 0;

  const updated = await params.prisma.channelSuggestionAdminDelivery.updateMany({
    where: {
      id: { in: rowIds },
      status: {
        in: [
          ChannelSuggestionAdminDeliveryStatus.PENDING,
          ChannelSuggestionAdminDeliveryStatus.FAILED,
        ],
      },
      terminal: false,
    },
    data: {
      status: ChannelSuggestionAdminDeliveryStatus.FAILED,
      ...(params.route
        ? {
            privateChatId: params.route.privateChatId,
            botId: params.route.botId,
          }
        : {}),
      ...(params.incrementAttemptCount === false ? {} : { attemptCount: { increment: 1 } }),
      lockedAt: null,
      lockToken: null,
      lastError: params.failure.message,
      lastStatusCode: params.failure.status,
      lastErrorCode: params.failure.code,
      terminal: params.failure.terminal || !params.failure.recoverable,
    },
  });
  return updated.count;
}

export async function reconcileAuthoritativeChannelSuggestionEditorRoster(params: {
  prisma: PrismaService;
  rosterAdminUserIds: readonly string[];
  retryableRows: readonly RetryableChannelSuggestionEditorRow[];
  knownBotUserIds: ReadonlySet<string>;
  isOwnBotUserId: (userId: string) => boolean;
  loadMissingAccess?: (userIds: string[]) => Promise<Map<string, ChannelSuggestionEditorAccess>>;
  onConfirmationError?: (error: unknown, userIds: string[]) => void;
}): Promise<string[]> {
  const adminUserIds = Array.from(new Set(params.rosterAdminUserIds));
  const current = new Set(adminUserIds);
  const missing = Array.from(
    new Set(
      params.retryableRows
        .map((row) => row.adminUserId)
        .filter((adminUserId) => !current.has(adminUserId)),
    ),
  );
  if (missing.length === 0 || !params.loadMissingAccess) return adminUserIds;

  let accessByUserId: Map<string, ChannelSuggestionEditorAccess>;
  try {
    accessByUserId = await params.loadMissingAccess(missing);
  } catch (error: unknown) {
    params.onConfirmationError?.(error, missing);
    return adminUserIds;
  }

  const removed = new Set<string>();
  for (const adminUserId of missing) {
    const access = accessByUserId.get(adminUserId);
    if (
      access &&
      (access.isAdmin || access.isOwner) &&
      !params.knownBotUserIds.has(adminUserId) &&
      !params.isOwnBotUserId(adminUserId)
    ) {
      current.add(adminUserId);
      adminUserIds.push(adminUserId);
    } else {
      removed.add(adminUserId);
    }
  }

  await persistChannelSuggestionPreclaimFailure({
    prisma: params.prisma,
    rowIds: params.retryableRows.filter((row) => removed.has(row.adminUserId)).map((row) => row.id),
    failure: {
      message: 'editor is no longer present in the authoritative channel admin roster',
      status: null,
      code: 'suggestion.delivery.editor_removed',
      terminal: true,
      recoverable: false,
    },
    incrementAttemptCount: false,
  });
  return adminUserIds;
}

export async function assertChannelSuggestionEditorBeforeDispatch(params: {
  adminUserId: string;
  knownBotUserIds: ReadonlySet<string>;
  isOwnBotUserId: (userId: string) => boolean;
  loadAccess?: () => Promise<ChannelSuggestionEditorAccess | null>;
}): Promise<void> {
  if (!params.loadAccess) {
    throw channelSuggestionEditorAccessError(
      503,
      'suggestion.delivery.editor_recheck_unavailable',
      'editor access recheck is unavailable before dispatch',
    );
  }

  let access: ChannelSuggestionEditorAccess | null;
  try {
    access = await params.loadAccess();
  } catch (error: unknown) {
    throw channelSuggestionEditorAccessError(
      503,
      'suggestion.delivery.editor_recheck_unavailable',
      error instanceof Error ? error.message : 'editor access recheck failed',
    );
  }
  if (!access) {
    throw channelSuggestionEditorAccessError(
      409,
      'suggestion.delivery.editor_removed',
      'editor is no longer a channel member before suggestion dispatch',
    );
  }
  if (
    (access.isAdmin || access.isOwner) &&
    !params.knownBotUserIds.has(params.adminUserId) &&
    !params.isOwnBotUserId(params.adminUserId)
  )
    return;
  throw channelSuggestionEditorAccessError(
    409,
    'suggestion.delivery.editor_removed',
    'editor lost channel admin access before suggestion dispatch',
  );
}

function channelSuggestionEditorAccessError(
  status: number,
  code: string,
  message: string,
): unknown {
  return { response: { status, data: { code, message } } };
}

export async function reconcileStaleChannelSuggestionDeliveryClaims(params: {
  prisma: PrismaService;
  staleBefore: Date;
  auditLogId?: string;
  limit?: number;
}): Promise<{ reclaimed: number; ambiguous: number; auditLogIds: string[] }> {
  const scope = params.auditLogId ? { auditLogId: params.auditLogId } : {};
  const staleRows = await params.prisma.channelSuggestionAdminDelivery.findMany({
    where: {
      ...scope,
      status: ChannelSuggestionAdminDeliveryStatus.SENDING,
      lockedAt: { lt: params.staleBefore },
    },
    select: { id: true, auditLogId: true, lastErrorCode: true },
    orderBy: [{ lockedAt: 'asc' }, { id: 'asc' }],
    ...(params.limit ? { take: params.limit } : {}),
  });
  const preDispatchIds = staleRows
    .filter((row) => row.lastErrorCode === CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE)
    .map((row) => row.id);
  const uncertainIds = staleRows
    .filter((row) => row.lastErrorCode !== CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE)
    .map((row) => row.id);
  const reclaimed = await params.prisma.channelSuggestionAdminDelivery.updateMany({
    where: {
      id: { in: preDispatchIds },
      status: ChannelSuggestionAdminDeliveryStatus.SENDING,
      lockedAt: { lt: params.staleBefore },
      lastErrorCode: CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE,
    },
    data: {
      status: ChannelSuggestionAdminDeliveryStatus.PENDING,
      lockedAt: null,
      lockToken: null,
      lastError: 'stale pre-dispatch delivery reclaimed before MAX send',
      lastStatusCode: null,
      lastErrorCode: null,
      terminal: false,
    },
  });
  const ambiguous = await params.prisma.channelSuggestionAdminDelivery.updateMany({
    where: {
      id: { in: uncertainIds },
      status: ChannelSuggestionAdminDeliveryStatus.SENDING,
      lockedAt: { lt: params.staleBefore },
    },
    data: {
      status: ChannelSuggestionAdminDeliveryStatus.AMBIGUOUS,
      lockedAt: null,
      lockToken: null,
      lastError: 'stale sending delivery; send outcome is ambiguous',
      terminal: false,
    },
  });
  return {
    reclaimed: reclaimed.count,
    ambiguous: ambiguous.count,
    auditLogIds: Array.from(new Set(staleRows.map((row) => row.auditLogId))),
  };
}

export async function finalizeConfirmedChannelSuggestionDelivery(params: {
  prisma: PrismaService;
  rowId: string;
  lockToken: string;
  privateChatId: string;
  botId: string;
  remoteMessageId: string;
}): Promise<boolean> {
  const sentAt = new Date();
  const data = {
    status: ChannelSuggestionAdminDeliveryStatus.SENT,
    privateChatId: params.privateChatId,
    botId: params.botId,
    remoteMessageId: params.remoteMessageId,
    sentAt,
    lockedAt: null,
    lockToken: null,
    lastError: null,
    lastStatusCode: null,
    lastErrorCode: null,
    terminal: false,
  } as const;
  try {
    const strict = await params.prisma.channelSuggestionAdminDelivery.updateMany({
      where: {
        id: params.rowId,
        status: ChannelSuggestionAdminDeliveryStatus.SENDING,
        lockToken: params.lockToken,
      },
      data,
    });
    if (strict.count === 1) return true;
  } catch {
    // The MAX response is already confirmed; recover persistence without another HTTP send.
  }

  const recovered = await params.prisma.channelSuggestionAdminDelivery.updateMany({
    where: {
      id: params.rowId,
      status: {
        in: [
          ChannelSuggestionAdminDeliveryStatus.PENDING,
          ChannelSuggestionAdminDeliveryStatus.SENDING,
          ChannelSuggestionAdminDeliveryStatus.FAILED,
          ChannelSuggestionAdminDeliveryStatus.AMBIGUOUS,
        ],
      },
    },
    data,
  });
  return recovered.count === 1;
}
