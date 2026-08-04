import type { Logger } from '@nestjs/common';
import { SanctionAction } from '../prisma/prisma-client';

export type PersistModerationEvent = (
  metadataPatch?: Record<string, unknown>,
  actionOverride?: SanctionAction,
) => Promise<unknown>;

export async function persistSanctionEventForNotice(params: {
  persistModerationEvent: PersistModerationEvent;
  metadata: Record<string, unknown>;
  actionLabel: 'ban' | 'mute';
  chatId: string;
  userId: string;
  messageId: string;
  logger: Pick<Logger, 'warn'>;
}): Promise<{ eventId: string | null; persisted: boolean }> {
  try {
    const event = await params.persistModerationEvent(params.metadata);
    return {
      eventId: readString(asRecord(event)?.id),
      persisted: true,
    };
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      `Failed to persist ${params.actionLabel} event before sending sanction notice`,
    );
    return { eventId: null, persisted: false };
  }
}

export function persistModerationDecisionWithoutAppliedSanction(
  persistModerationEvent: PersistModerationEvent,
  action: SanctionAction,
): Promise<unknown> {
  const sanctionWasNotApplied = action === SanctionAction.MUTE || action === SanctionAction.BAN;
  return persistModerationEvent(
    sanctionWasNotApplied
      ? {
          attemptedAction: action,
          sanctionApplied: false,
        }
      : {},
    sanctionWasNotApplied ? SanctionAction.NONE : action,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}
