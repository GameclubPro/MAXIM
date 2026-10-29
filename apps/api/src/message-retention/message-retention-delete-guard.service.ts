import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { retentionBindingQuery, type RetentionBindingRow } from './message-retention-binding';

export type MessageRetentionGuardReason =
  | 'protected_author'
  | 'pinned'
  | 'activation_ended'
  | 'runtime_disabled'
  | 'runtime_retired'
  | 'author_unknown'
  | 'evidence_expired'
  | 'policy_changed'
  | 'identity_changed'
  | 'not_due'
  | 'ownership_changed'
  | 'capacity_paused'
  | 'candidate_inactive'
  | 'entity_ineligible';

export class MessageRetentionGuardError extends Error {
  readonly code = 'message_retention_guard_rejected';
  constructor(
    readonly disposition: 'skip' | 'retry',
    message: string,
    readonly reasonCode?: MessageRetentionGuardReason,
  ) {
    super(message);
  }
}

@Injectable()
export class MessageRetentionDeleteGuard {
  constructor(private readonly prisma: PrismaService) {}

  async assertAllowed(
    intentId: string,
    _botId: string,
    _phase: 'prepare' | 'dispatch' = 'prepare',
  ): Promise<void> {
    // FLAG: Retain the final dispatch boundary for old journals and shared callers.
    // No rollout flag can restore Major's retired age-based deletion engine.
    throw new MessageRetentionGuardError(
      'skip',
      await this.retirementReason(intentId),
      'runtime_retired',
    );
  }

  private async retirementReason(intentId: string): Promise<string> {
    // FLAG: Keep the ownership reader compatible with the installed deploy controller.
    // This indexed local observation changes only the rejection text, never execution authority.
    const [binding] = await this.prisma.$queryRaw<RetentionBindingRow[]>(
      retentionBindingQuery(intentId),
    );
    return binding?.eraserOwned
      ? 'History cleanup belongs to Lastik; Major execution is retired'
      : 'Legacy history cleanup is retired';
  }
}
