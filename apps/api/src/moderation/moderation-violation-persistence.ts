import { randomUUID } from 'node:crypto';

import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildModerationMessageViolationProcessingClaimKey,
  claimPersistedModerationMessageViolation,
  type ModerationMessageViolationProcessingClaimKey,
  type ModerationViolationMessageClaimModel,
  type PersistedModerationMessageClaimResult,
} from './moderation-message-action-claim';

export type ModerationMessageViolationPersistenceInput = {
  chatId: string;
  userId: string;
  messageId?: string | null;
  ruleCode: string;
  updateType?: string | null;
  score: number;
};

type NormalizedModerationMessageViolationPersistenceInput =
  ModerationMessageViolationPersistenceInput & {
    messageId: string;
    updateType: string;
  };

type ModerationMessageViolationPersistenceContext = {
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  updateType: string;
};

type OwnedModerationViolationMessageClaimModel = {
  create?: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  createMany?: (args: {
    data: Array<Record<string, unknown>>;
    skipDuplicates?: boolean;
  }) => Promise<{ count: number }>;
};

type ModerationViolationMessageClaimOwnershipLookup = {
  findUnique?: (args: {
    where: { dedupeKey: string };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
};

export type PersistedMessageViolationProcessingInput = {
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  updateType: string;
  dedupeKey: string;
  resumeKnownActionOwner?: boolean;
};

export function claimPersistedMessageViolationProcessing(
  prismaService: PrismaService,
  params: PersistedMessageViolationProcessingInput,
): Promise<PersistedModerationMessageClaimResult> {
  const { resumeKnownActionOwner, ...data } = params;
  const claimModel = (
    prismaService as unknown as {
      moderationViolationMessageClaim?: PrismaService['moderationViolationMessageClaim'];
    }
  ).moderationViolationMessageClaim;
  return claimPersistedModerationMessageViolation({
    model: claimModel as unknown as ModerationViolationMessageClaimModel | undefined,
    data,
    resumeKnownActionOwner,
  });
}

export async function claimAndPersistModerationMessageViolation(
  prismaService: PrismaService,
  params: ModerationMessageViolationPersistenceInput,
  claimFallback: (input: NormalizedModerationMessageViolationPersistenceInput) => Promise<boolean>,
  onDuplicate: (context: ModerationMessageViolationPersistenceContext) => void,
  markRedis: (
    claimKey: ModerationMessageViolationProcessingClaimKey,
    context: ModerationMessageViolationPersistenceContext,
  ) => Promise<unknown>,
): Promise<boolean> {
  const messageId = params.messageId?.trim();
  if (!messageId) {
    await prismaService.violation.create({
      data: {
        chatId: params.chatId,
        userId: params.userId,
        ruleCode: params.ruleCode,
        score: params.score,
      },
    });
    return true;
  }

  const updateType = params.updateType?.trim().toLowerCase() || 'message';
  const claimKey = buildModerationMessageViolationProcessingClaimKey({
    chatId: params.chatId,
    userId: params.userId,
    messageId,
    ruleCode: params.ruleCode,
    updateType,
  });
  const prisma = prismaService as unknown as {
    $transaction?: <Result>(
      operation: (tx: Prisma.TransactionClient) => Promise<Result>,
    ) => Promise<Result>;
    moderationViolationMessageClaim?: PrismaService['moderationViolationMessageClaim'];
  };
  const claimModel = prisma.moderationViolationMessageClaim;

  if (
    typeof prisma.$transaction !== 'function' ||
    (!claimModel?.create && !claimModel?.createMany)
  ) {
    const claimed = await claimFallback({ ...params, messageId, updateType });
    if (!claimed) {
      return false;
    }
    await prismaService.violation.create({
      data: {
        chatId: params.chatId,
        userId: params.userId,
        ruleCode: params.ruleCode,
        score: params.score,
      },
    });
    return true;
  }

  const claimOwnerId = randomUUID();
  let transactionEffectsCompleted = false;

  // FLAG: Claim and first durable effect commit together; keep Redis and MAX calls outside.
  let claimed: boolean;
  try {
    claimed = await prisma.$transaction(async (tx) => {
      const txClaimModel =
        tx.moderationViolationMessageClaim as unknown as OwnedModerationViolationMessageClaimModel;
      const persistedClaim = await claimPersistedModerationMessageViolation({
        model: {
          ...(txClaimModel.create
            ? {
                create: ({ data }) =>
                  txClaimModel.create!({ data: { id: claimOwnerId, ...data } }),
              }
            : {}),
          ...(txClaimModel.createMany
            ? {
                createMany: ({ data, skipDuplicates }) =>
                  txClaimModel.createMany!({
                    data: data.map((row) => ({ id: claimOwnerId, ...row })),
                    skipDuplicates,
                  }),
              }
            : {}),
        },
        data: {
          chatId: params.chatId,
          userId: params.userId,
          messageId,
          ruleCode: params.ruleCode,
          updateType,
          dedupeKey: claimKey.dedupeKey,
        },
      });
      if (persistedClaim === 'duplicate') {
        return false;
      }
      if (persistedClaim !== 'claimed') {
        throw new Error(`Transactional moderation message claim is unavailable (${persistedClaim})`);
      }

      await tx.violation.create({
        data: {
          chatId: params.chatId,
          userId: params.userId,
          ruleCode: params.ruleCode,
          score: params.score,
        },
      });
      transactionEffectsCompleted = true;
      return true;
    });
  } catch (error: unknown) {
    const committedByThisAttempt =
      transactionEffectsCompleted &&
      (await hasOwnedCommittedModerationClaim(
        claimModel as unknown as ModerationViolationMessageClaimOwnershipLookup,
        claimKey.dedupeKey,
        claimOwnerId,
      ));
    if (!committedByThisAttempt) {
      throw error;
    }
    claimed = true;
  }

  const context = {
    chatId: params.chatId,
    userId: params.userId,
    messageId,
    ruleCode: params.ruleCode,
    updateType,
  };
  if (!claimed) {
    onDuplicate(context);
    return false;
  }

  if (updateType !== 'message_action') {
    // The durable DB claim is authoritative. Redis only warms the fast duplicate path and must not
    // strand sanctions after commit when the cache is slow or unavailable.
    void Promise.resolve()
      .then(() => markRedis(claimKey, context))
      .catch(() => undefined);
  }
  return true;
}

async function hasOwnedCommittedModerationClaim(
  model: ModerationViolationMessageClaimOwnershipLookup,
  dedupeKey: string,
  claimOwnerId: string,
): Promise<boolean> {
  if (!model.findUnique) {
    return false;
  }

  try {
    const persisted = await model.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });
    return persisted?.id === claimOwnerId;
  } catch {
    return false;
  }
}
