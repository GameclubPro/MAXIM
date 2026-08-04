import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { EventType, Operator, Prisma, SanctionAction } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

export const SANCTION_STATE_FENCE_RULE_CODE = 'SANCTION_STATE_FENCE';

const SANCTION_STATE_FENCE_VERSION = 1 as const;
const MAX_MATCHING_FENCE_EVENTS = 128;

export type ModerationSanctionStateIntendedAction = 'BAN' | 'MUTE' | 'UNBAN' | 'UNMUTE';

export type ModerationSanctionStateFence = Readonly<{
  version: typeof SANCTION_STATE_FENCE_VERSION;
  transitionId: string;
  chatId: string;
  userId: string;
  intendedAction: ModerationSanctionStateIntendedAction;
  operator: Operator;
  source?: string;
  invalidatedSanctionEventIds: readonly string[];
}>;

export type PrepareModerationSanctionStateFenceParams = {
  chatId: string;
  userId: string;
  intendedAction: ModerationSanctionStateIntendedAction;
  operator: Operator;
  source?: string;
};

export type IsSanctionEventInvalidatedParams = {
  chatId: string;
  userId: string;
  sanctionEventId: string;
  eventCreatedAt?: Date;
};

type SanctionStateFencePhase =
  | 'PREPARED'
  | 'COMMITTED'
  | 'REMOTE_CONFIRMED_EVENT_MISSING'
  | 'ABORTED';

type SanctionStateFenceMetadata = {
  version: typeof SANCTION_STATE_FENCE_VERSION;
  transitionId: string;
  intendedAction: ModerationSanctionStateIntendedAction;
  invalidatedSanctionEventIds: string[];
  phase: SanctionStateFencePhase;
  source?: string;
  eventId?: string;
};

type ParsedSanctionStateFencePhase = Pick<SanctionStateFenceMetadata, 'transitionId' | 'phase'>;

type ResolvedSanctionStateFencePhases = {
  prepared: boolean;
  committed: boolean;
  aborted: boolean;
};

@Injectable()
export class ModerationSanctionStateFenceService {
  constructor(private readonly prisma: PrismaService) {}

  async prepare(
    params: PrepareModerationSanctionStateFenceParams,
  ): Promise<ModerationSanctionStateFence> {
    const latestStateEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId: params.chatId,
        userId: params.userId,
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        action: true,
      },
    });
    const invalidatedSanctionEventIds =
      latestStateEvent && this.isSanctionAction(latestStateEvent.action)
        ? [latestStateEvent.id]
        : [];
    const source = this.normalizeOptionalString(params.source);
    const fence: ModerationSanctionStateFence = {
      version: SANCTION_STATE_FENCE_VERSION,
      transitionId: randomUUID(),
      chatId: params.chatId,
      userId: params.userId,
      intendedAction: params.intendedAction,
      operator: params.operator,
      ...(source ? { source } : {}),
      invalidatedSanctionEventIds,
    };

    await this.appendPhase(fence, 'PREPARED');
    return fence;
  }

  async commit(fence: ModerationSanctionStateFence, eventId?: string): Promise<void> {
    await this.appendPhase(fence, 'COMMITTED', eventId);
  }

  async markRemoteConfirmedEventMissing(fence: ModerationSanctionStateFence): Promise<void> {
    await this.appendPhase(fence, 'REMOTE_CONFIRMED_EVENT_MISSING');
  }

  async abort(fence: ModerationSanctionStateFence): Promise<void> {
    await this.appendPhase(fence, 'ABORTED');
  }

  async isSanctionEventInvalidated(params: IsSanctionEventInvalidatedParams): Promise<boolean> {
    const eventCreatedAt = await this.resolveSanctionEventCreatedAt(params);
    if (!eventCreatedAt) {
      return false;
    }

    const rows = await this.prisma.moderationEvent.findMany({
      where: {
        chatId: params.chatId,
        userId: params.userId,
        ruleCode: SANCTION_STATE_FENCE_RULE_CODE,
        createdAt: {
          gte: eventCreatedAt,
        },
        metadata: {
          path: ['invalidatedSanctionEventIds'],
          array_contains: [params.sanctionEventId],
        } satisfies Prisma.JsonFilter,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_MATCHING_FENCE_EVENTS + 1,
      select: {
        metadata: true,
      },
    });

    const resolvedTransitions = new Map<string, ResolvedSanctionStateFencePhases>();
    for (const row of rows) {
      const metadata = this.readFencePhase(row.metadata, params.sanctionEventId);
      if (!metadata) {
        continue;
      }
      const phases = resolvedTransitions.get(metadata.transitionId) ?? {
        prepared: false,
        committed: false,
        aborted: false,
      };
      if (metadata.phase === 'PREPARED') {
        phases.prepared = true;
      } else if (metadata.phase === 'ABORTED') {
        phases.aborted = true;
      } else {
        phases.committed = true;
      }
      resolvedTransitions.set(metadata.transitionId, phases);
    }

    for (const phases of resolvedTransitions.values()) {
      if (phases.committed || (phases.prepared && !phases.aborted)) {
        return true;
      }
    }

    return rows.length > MAX_MATCHING_FENCE_EVENTS;
  }

  private async appendPhase(
    fence: ModerationSanctionStateFence,
    phase: SanctionStateFencePhase,
    eventId?: string,
  ): Promise<void> {
    if (fence.invalidatedSanctionEventIds.length === 0) {
      return;
    }

    const normalizedEventId = this.normalizeOptionalString(eventId);
    const metadata: SanctionStateFenceMetadata = {
      version: fence.version,
      transitionId: fence.transitionId,
      intendedAction: fence.intendedAction,
      invalidatedSanctionEventIds: [...fence.invalidatedSanctionEventIds],
      phase,
      ...(fence.source ? { source: fence.source } : {}),
      ...(normalizedEventId ? { eventId: normalizedEventId } : {}),
    };

    await this.prisma.moderationEvent.create({
      data: {
        chatId: fence.chatId,
        userId: fence.userId,
        messageId: null,
        eventType: EventType.SYSTEM,
        ruleCode: SANCTION_STATE_FENCE_RULE_CODE,
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: 0,
        operator: fence.operator,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  private async resolveSanctionEventCreatedAt(
    params: IsSanctionEventInvalidatedParams,
  ): Promise<Date | null> {
    if (params.eventCreatedAt instanceof Date && Number.isFinite(params.eventCreatedAt.getTime())) {
      return params.eventCreatedAt;
    }

    const event = await this.prisma.moderationEvent.findUnique({
      where: { id: params.sanctionEventId },
      select: {
        chatId: true,
        userId: true,
        createdAt: true,
      },
    });
    if (event?.chatId !== params.chatId || event.userId !== params.userId) {
      return null;
    }
    return event.createdAt;
  }

  private readFencePhase(
    value: Prisma.JsonValue,
    sanctionEventId: string,
  ): ParsedSanctionStateFencePhase | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const metadata = value as Record<string, unknown>;
    if (metadata.version !== SANCTION_STATE_FENCE_VERSION) {
      return null;
    }
    const transitionId = this.normalizeOptionalString(metadata.transitionId);
    if (!transitionId || !this.isFencePhase(metadata.phase)) {
      return null;
    }
    if (
      !Array.isArray(metadata.invalidatedSanctionEventIds) ||
      !metadata.invalidatedSanctionEventIds.some((id) => id === sanctionEventId)
    ) {
      return null;
    }

    return {
      transitionId,
      phase: metadata.phase,
    };
  }

  private isSanctionAction(action: SanctionAction): boolean {
    return action === SanctionAction.BAN || action === SanctionAction.MUTE;
  }

  private isFencePhase(value: unknown): value is SanctionStateFencePhase {
    return (
      value === 'PREPARED' ||
      value === 'COMMITTED' ||
      value === 'REMOTE_CONFIRMED_EVENT_MISSING' ||
      value === 'ABORTED'
    );
  }

  private normalizeOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
