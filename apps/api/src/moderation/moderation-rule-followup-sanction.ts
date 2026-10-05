export type RuleFollowupSanctionAction = 'NONE' | 'WARN' | 'MUTE' | 'BAN';

export type FrozenRuleFollowupSanctionPlan = Readonly<{
  action: RuleFollowupSanctionAction;
  issuedAtMs: number;
  muteExpiresAtMs: number | null;
  muteDurationHours: number;
  eventId: string;
  noticeKey: string;
}>;

export type RuleFollowupSanctionState = Readonly<{
  phase: 'UNSTARTED' | 'BAN_STARTED' | 'BAN_CONFIRMED' | 'UNKNOWN' | 'SQL_COMMITTED' | 'SETTLED';
  banBotId?: string | null;
  eventId?: string | null;
}>;

export type RuleFollowupBanOutcome =
  | { kind: 'confirmed'; botId: string | null }
  | { kind: 'no_effect' }
  | { kind: 'unknown' };

export interface RuleFollowupSanctionJournal {
  readonly id: string;
  readonly receiptOnly?: boolean;
  assertLease(): Promise<void>;
  readState(): Promise<RuleFollowupSanctionState>;
  beginBan(actionKey: string): Promise<boolean>;
  confirmBan(botId: string | null): Promise<void>;
  resetAfterProvenNoEffect(): Promise<void>;
  markUnknown(): Promise<void>;
  commitSqlEvent(eventId: string): Promise<void>;
  claimReputation(): Promise<'run' | 'done' | 'unknown'>;
  completeReputation(): Promise<void>;
  settle(): Promise<void>;
}

export interface RuleFollowupSanctionDependencies {
  authorize(): Promise<boolean>;
  ban(params: {
    actionKey: string;
    beforeMutation: () => Promise<void>;
  }): Promise<RuleFollowupBanOutcome>;
  // FLAG: Only this plan's exact retained MAX ledger can prove a prior BAN. Missing state
  // after dispatch start, including after UNBAN removed a ledger, is unknown, never no_effect.
  recoverBanReceipt(actionKey: string): Promise<RuleFollowupBanOutcome>;
  persistDeterministicEvent(params: {
    eventId: string;
    action: RuleFollowupSanctionAction;
    issuedAtMs: number;
    muteExpiresAtMs: number | null;
    muteDurationHours: number;
  }): Promise<string>;
  // FLAG: Cache writes derive the currently effective SQL event and honor later manual
  // releases. Repeated recovery must not restore a mute that a newer admin action removed.
  rememberActiveMute(params: {
    eventId: string;
    issuedAtMs: number;
    expiresAtMs: number;
    durationHours: number;
  }): Promise<void>;
  rememberInactiveMute(): Promise<void>;
  recordReputation(params: { effectKey: string; observedAtMs: number }): Promise<void>;
  sendNotice(params: {
    idempotencyKey: string;
    sanctionEventId: string;
    botId: string | null;
  }): Promise<void>;
}

export class RuleFollowupBanOutcomeUnknownError extends Error {
  readonly code = 'moderation_rule_followup_ban_outcome_unknown';

  constructor() {
    super('Rule follow-up BAN requires receipt settlement before continuation');
  }
}

export class RuleFollowupSanctionDeferredError extends Error {
  readonly code = 'moderation_rule_followup_sanction_deferred';
}

export class RuleFollowupSanctionInvalidError extends Error {
  readonly code = 'moderation_rule_followup_sanction_invalid';
}

function assertPlan(plan: FrozenRuleFollowupSanctionPlan): void {
  if (
    !['NONE', 'WARN', 'MUTE', 'BAN'].includes(plan.action) ||
    !Number.isSafeInteger(plan.issuedAtMs) ||
    plan.issuedAtMs <= 0 ||
    typeof plan.eventId !== 'string' ||
    !plan.eventId.trim() ||
    typeof plan.noticeKey !== 'string' ||
    !plan.noticeKey.trim() ||
    !Number.isFinite(plan.muteDurationHours) ||
    plan.muteDurationHours < 0 ||
    (plan.action === 'MUTE' &&
      (plan.muteDurationHours <= 0 ||
        !Number.isSafeInteger(plan.muteExpiresAtMs) ||
        plan.muteExpiresAtMs! <= plan.issuedAtMs))
  )
    throw new RuleFollowupSanctionInvalidError(
      'Invalid immutable moderation rule follow-up sanction plan',
    );
}

function assertState(state: RuleFollowupSanctionState, plan: FrozenRuleFollowupSanctionPlan): void {
  // FLAG: Durable JSON is untrusted at recovery. An unknown phase must not skip new-effect
  // authorization, and only this plan's exact SQL receipt permits settled replay.
  if (
    !state ||
    !['UNSTARTED', 'BAN_STARTED', 'BAN_CONFIRMED', 'UNKNOWN', 'SQL_COMMITTED', 'SETTLED'].includes(
      state.phase,
    ) ||
    (['BAN_STARTED', 'BAN_CONFIRMED', 'UNKNOWN'].includes(state.phase) && plan.action !== 'BAN') ||
    (['SQL_COMMITTED', 'SETTLED'].includes(state.phase) && state.eventId !== plan.eventId) ||
    (state.banBotId != null && (typeof state.banBotId !== 'string' || !state.banBotId.trim()))
  )
    throw new RuleFollowupSanctionInvalidError(
      'Invalid immutable moderation rule follow-up sanction state',
    );
}

export async function executeRuleFollowupSanction(
  plan: FrozenRuleFollowupSanctionPlan,
  journal: RuleFollowupSanctionJournal,
  dependencies: RuleFollowupSanctionDependencies,
): Promise<boolean> {
  assertPlan(plan);
  await journal.assertLease();
  let state = await journal.readState();
  assertState(state, plan);
  if (state.phase === 'SETTLED') return true;
  const actionKey = `${journal.id}:sanction-ban`;
  const settleBan = async (outcome: RuleFollowupBanOutcome): Promise<void> => {
    await journal.assertLease();
    if (outcome.kind === 'confirmed') {
      await journal.confirmBan(outcome.botId);
      state = { phase: 'BAN_CONFIRMED', banBotId: outcome.botId };
      return;
    }
    if (outcome.kind === 'no_effect') {
      await journal.resetAfterProvenNoEffect();
      throw new RuleFollowupSanctionDeferredError('BAN was rejected without an effect');
    }
    await journal.markUnknown();
    throw new RuleFollowupBanOutcomeUnknownError();
  };
  if (state.phase === 'UNKNOWN') {
    const receipt = await dependencies.recoverBanReceipt(actionKey);
    // FLAG: A later exact positive receipt permits database settlement after quarantine.
    // Missing or negative state cannot retrospectively prove an unknown effect absent.
    if (receipt.kind !== 'confirmed') throw new RuleFollowupBanOutcomeUnknownError();
    await settleBan(receipt);
  }
  if (state.phase === 'BAN_STARTED') {
    // FLAG: Receipt settlement precedes policy/deadline checks. Never repeat remote BAN
    // from a started outbox step or substitute another plan's successful member action.
    await settleBan(await dependencies.recoverBanReceipt(actionKey));
  }
  if (state.phase === 'UNSTARTED') {
    if (!(await dependencies.authorize())) return false;
    await journal.assertLease();
    if (plan.action === 'BAN') {
      if (!(await journal.beginBan(actionKey)))
        throw new RuleFollowupSanctionDeferredError('BAN start ownership changed');
      let outcome: RuleFollowupBanOutcome;
      try {
        outcome = await dependencies.ban({
          actionKey,
          beforeMutation: async () => {
            await journal.assertLease();
            if (!(await dependencies.authorize()))
              throw new RuleFollowupSanctionDeferredError('Sanction authority changed before BAN');
          },
        });
      } catch {
        // FLAG: The transport adapter returns proven no-effect failures explicitly. An
        // unclassified exception after start retains the fence and requires exact receipt proof.
        outcome = await dependencies.recoverBanReceipt(actionKey);
      }
      await settleBan(outcome);
    }
  }
  if (state.phase !== 'SQL_COMMITTED') {
    await journal.assertLease();
    const eventId = await dependencies.persistDeterministicEvent({
      eventId: plan.eventId,
      action: plan.action,
      issuedAtMs: plan.issuedAtMs,
      muteExpiresAtMs: plan.muteExpiresAtMs,
      muteDurationHours: plan.muteDurationHours,
    });
    if (eventId !== plan.eventId)
      throw new Error('Sanction event receipt differs from its immutable follow-up plan');
    await journal.commitSqlEvent(eventId);
  } else if (state.eventId !== plan.eventId) {
    throw new Error('Committed sanction event differs from its immutable follow-up plan');
  }
  await journal.assertLease();
  if (plan.action === 'MUTE') {
    await dependencies.rememberActiveMute({
      eventId: plan.eventId,
      issuedAtMs: plan.issuedAtMs,
      expiresAtMs: plan.muteExpiresAtMs!,
      durationHours: plan.muteDurationHours,
    });
  } else if (plan.action === 'BAN') {
    await dependencies.rememberInactiveMute();
    // FLAG: Reputation may run once, only after a confirmed BAN. A crash after its start
    // keeps an unknown observation checkpoint; it must never inflate a detection on replay.
    if ((await journal.claimReputation()) === 'run') {
      await dependencies.recordReputation({
        effectKey: `${journal.id}:sanction-reputation`,
        observedAtMs: plan.issuedAtMs,
      });
      await journal.completeReputation();
    }
  }
  await journal.assertLease();
  await dependencies.sendNotice({
    idempotencyKey: plan.noticeKey,
    sanctionEventId: plan.eventId,
    botId: state.banBotId ?? null,
  });
  await journal.settle();
  return true;
}
