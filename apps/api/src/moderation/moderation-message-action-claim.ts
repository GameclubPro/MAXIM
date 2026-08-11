import { createHash } from 'node:crypto';

export type ModerationMessageActionClaimData = {
  dedupeKey: string;
  messageActionKey: string;
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  updateType: 'message_action';
};

export type ModerationMessageActionClaimRecord = ModerationMessageActionClaimData;

export type ModerationMessageActionClaimModel = {
  create?: (args: { data: ModerationMessageActionClaimData }) => Promise<unknown>;
  createMany?: (args: {
    data: ModerationMessageActionClaimData[];
    skipDuplicates?: boolean;
  }) => Promise<{ count: number }>;
  findUnique?: (args: {
    where: { messageActionKey: string };
    select: Record<keyof ModerationMessageActionClaimRecord, true>;
  }) => Promise<ModerationMessageActionClaimRecord | null>;
};

export type ModerationViolationMessageClaimModel = {
  create?: (args: { data: ModerationViolationMessageClaimData }) => Promise<unknown>;
  createMany?: (args: {
    data: ModerationViolationMessageClaimData[];
    skipDuplicates?: boolean;
  }) => Promise<{ count: number }>;
  findUnique?: ModerationMessageActionClaimModel['findUnique'];
};

type ModerationViolationMessageClaimData = Omit<
  ModerationMessageActionClaimData,
  'messageActionKey' | 'updateType'
> & {
  messageActionKey: string | null;
  updateType: string;
};

export type PersistedModerationMessageClaimResult =
  | 'claimed'
  | 'resumed'
  | 'duplicate'
  | 'unavailable'
  | 'unsupported';

export type TerminalDuplicateSanctionEventModel = {
  findFirst?: (args: {
    where: {
      chatId: string;
      userId: string;
      messageId: string;
      ruleCode: { in: string[] };
      operator: 'BOT';
    };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
};

export type DurableModerationMessageActionClaimResult = 'claimed' | 'resumed' | 'blocked';

export type DuplicateMessageActionPersistInput = {
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  updateType: 'message_action';
  dedupeKey: string;
  resumeKnownActionOwner: true;
};

export type ModerationMessageViolationProcessingClaimKey = {
  dedupeKey: string;
  counterKey: string;
  memberKey: string;
};

const MESSAGE_ACTION_CLAIM_SELECT = {
  dedupeKey: true,
  messageActionKey: true,
  chatId: true,
  userId: true,
  messageId: true,
  ruleCode: true,
  updateType: true,
} as const;

export function buildMessageScopedModerationActionClaimKey(
  chatId: string,
  messageId: string,
): string {
  const semanticHash = createHash('sha256')
    .update(JSON.stringify([chatId, messageId]))
    .digest('hex');
  return `v1:${semanticHash}`;
}

export function buildModerationMessageViolationProcessingClaimKey(params: {
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  updateType: string;
}): ModerationMessageViolationProcessingClaimKey {
  const semanticHash = createHash('sha256')
    .update(
      `${params.chatId}:${params.userId}:${params.messageId}:${params.ruleCode}:${params.updateType}`,
    )
    .digest('hex');
  const counterKey = `moderation:violation-message:v1:${params.chatId}:${params.ruleCode}`;
  return {
    dedupeKey: `v1:${semanticHash}`,
    counterKey,
    memberKey: `${counterKey}:msg:${semanticHash.slice(0, 32)}`,
  };
}

export function isOwnedModerationMessageActionClaim(
  existing: ModerationMessageActionClaimRecord,
  expected: ModerationMessageActionClaimData,
): boolean {
  return (
    existing.dedupeKey === expected.dedupeKey &&
    existing.messageActionKey === expected.messageActionKey &&
    existing.chatId === expected.chatId &&
    existing.userId === expected.userId &&
    existing.messageId === expected.messageId &&
    existing.ruleCode === expected.ruleCode &&
    existing.updateType === expected.updateType
  );
}

export async function claimDurableModerationMessageAction(params: {
  model: ModerationMessageActionClaimModel;
  data: ModerationMessageActionClaimData;
  resumeKnownOwner: boolean;
}): Promise<DurableModerationMessageActionClaimResult> {
  const { data, model } = params;
  let createError: unknown = null;

  try {
    if (model.createMany) {
      const created = await model.createMany({ data: [data], skipDuplicates: true });
      if (created.count > 0) {
        return 'claimed';
      }
      if (!params.resumeKnownOwner) {
        return 'blocked';
      }
    } else if (model.create) {
      await model.create({ data });
      return 'claimed';
    } else {
      throw new Error('Moderation message action claim storage is unsupported');
    }
  } catch (error: unknown) {
    createError = error;
  }

  if (!model.findUnique) {
    throw createError instanceof Error
      ? createError
      : new Error('Moderation message action claim could not be reconciled');
  }

  const existing = await model.findUnique({
    where: { messageActionKey: data.messageActionKey },
    select: MESSAGE_ACTION_CLAIM_SELECT,
  });
  if (!existing) {
    throw createError instanceof Error
      ? createError
      : new Error('Moderation message action claim could not be reconciled');
  }
  if (!isOwnedModerationMessageActionClaim(existing, data)) {
    return 'blocked';
  }
  return params.resumeKnownOwner ? 'resumed' : 'blocked';
}

export async function claimPersistedModerationMessageViolation(params: {
  model?: ModerationViolationMessageClaimModel;
  data: Omit<ModerationViolationMessageClaimData, 'messageActionKey'>;
  resumeKnownActionOwner?: boolean;
}): Promise<PersistedModerationMessageClaimResult> {
  const { model } = params;
  if (!model?.create && !model?.createMany) {
    return 'unsupported';
  }

  const messageActionKey =
    params.data.updateType === 'message_action'
      ? buildMessageScopedModerationActionClaimKey(params.data.chatId, params.data.messageId)
      : null;
  const data = { ...params.data, messageActionKey };

  try {
    if (params.data.updateType === 'message_action') {
      const result = await claimDurableModerationMessageAction({
        model: model as ModerationMessageActionClaimModel,
        data: { ...data, messageActionKey: messageActionKey!, updateType: 'message_action' },
        resumeKnownOwner: params.resumeKnownActionOwner === true,
      });
      if (result === 'blocked') {
        return 'duplicate';
      }
      return result === 'resumed' && params.resumeKnownActionOwner !== true ? 'claimed' : result;
    }
    if (model.createMany) {
      const created = await model.createMany({ data: [data], skipDuplicates: true });
      return created.count > 0 ? 'claimed' : 'duplicate';
    }
    await model.create!({ data });
    return 'claimed';
  } catch (error: unknown) {
    if (params.data.updateType === 'message_action') {
      throw error;
    }
    if (isUniqueConstraintError(error)) {
      return 'duplicate';
    }
    return 'unavailable';
  }
}

export async function resolveDuplicateMessageActionClaim(params: {
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  claimPersisted: (
    input: DuplicateMessageActionPersistInput,
  ) => Promise<PersistedModerationMessageClaimResult>;
  hasLegacyEvent: () => Promise<boolean>;
}): Promise<DurableModerationMessageActionClaimResult> {
  const { claimPersisted, hasLegacyEvent, ...identity } = params;
  const claimKey = buildModerationMessageViolationProcessingClaimKey({
    ...identity,
    updateType: 'message_action',
  });
  const persisted = await claimPersisted({
    ...identity,
    updateType: 'message_action',
    dedupeKey: claimKey.dedupeKey,
    resumeKnownActionOwner: true,
  });
  if (persisted === 'claimed' || persisted === 'resumed') {
    return persisted;
  }
  if (persisted === 'unsupported') {
    return (await hasLegacyEvent()) ? 'blocked' : 'claimed';
  }
  return 'blocked';
}

export async function hasPersistedTerminalDuplicateSanction(params: {
  model?: TerminalDuplicateSanctionEventModel;
  chatId: string;
  userId: string;
  messageId: string;
}): Promise<boolean> {
  if (!params.model?.findFirst) {
    throw new Error('Terminal duplicate sanction lookup is unsupported');
  }
  const existing = await params.model.findFirst({
    where: {
      chatId: params.chatId,
      userId: params.userId,
      messageId: params.messageId,
      ruleCode: { in: ['DUPLICATE_WARN', 'DUPLICATE_MUTE', 'DUPLICATE_BAN'] },
      operator: 'BOT',
    },
    select: { id: true },
  });
  return existing !== null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
