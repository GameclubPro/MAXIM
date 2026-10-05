import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ParticipantModerationImmunityService } from '../moderation/participant-moderation-immunity.service';
import {
  assertModerationRuleSanctionAuthority,
  ModerationRuleSanctionRejectedError,
  type ModerationRuleMemberAccess,
  type ModerationRuleSanctionAuthority,
} from '../moderation/moderation-rule-sanction-authority';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { buildMaxActionIdempotencyKey } from './max-action-idempotency';
import type { MaxActionJob } from './max-client.service';

export type MaxModerationRuleNoticeProof = ModerationRuleSanctionAuthority & { version: 1 };
export type MaxModerationRuleNoticeMemberAccessReader = (params: {
  chatId: string;
  userId: string;
  botId: string;
  timeoutMs: number;
}) => Promise<ModerationRuleMemberAccess>;

export class MaxModerationRuleNoticeRejectedError extends UnrecoverableError {
  readonly code = 'moderation_rule_notice_no_longer_authorized';
  constructor() {
    super('moderation_rule_notice_no_longer_authorized');
  }
}

export function hasMaxModerationRuleNoticeProof(
  action: Pick<MaxActionJob, 'ledgerContext'>,
): boolean {
  return (
    !!action.ledgerContext &&
    (Object.hasOwn(action.ledgerContext, 'moderationRuleNotice') ||
      Object.hasOwn(action.ledgerContext, 'moderationRuleFollowup'))
  );
}

type DurableFollowupNoticeProof = { version: 1; id: string; issuedAtMs: number };

function readDurableFollowupProof(action: MaxActionJob): DurableFollowupNoticeProof | undefined {
  if (!action.ledgerContext || !Object.hasOwn(action.ledgerContext, 'moderationRuleFollowup'))
    return undefined;
  const value = action.ledgerContext.moderationRuleFollowup;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['version', 'id', 'issuedAtMs'].includes(key)) ||
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    value.id.length > 256 ||
    !Number.isSafeInteger(value.issuedAtMs) ||
    (value.issuedAtMs as number) <= 0
  )
    throw new MaxModerationRuleNoticeRejectedError();
  return value as DurableFollowupNoticeProof;
}

function readProof(action: MaxActionJob): MaxModerationRuleNoticeProof {
  const value = action.ledgerContext?.moderationRuleNotice;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MaxModerationRuleNoticeRejectedError();
  const keys = ['chatId', 'messageId', 'userId', 'reasonKey', 'ruleCode', 'policySha256'];
  if (
    value.version !== 1 ||
    Object.keys(value).length !== keys.length + 2 ||
    keys.some(
      (key) =>
        typeof value[key] !== 'string' ||
        !(value[key] as string).trim() ||
        (value[key] as string).length > 1_024,
    ) ||
    typeof value.policySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.policySha256) ||
    !Number.isSafeInteger(value.deadlineAtMs) ||
    action.actionType !== 'SEND_MESSAGE' ||
    value.chatId !== action.chatId
  )
    throw new MaxModerationRuleNoticeRejectedError();
  return value as MaxModerationRuleNoticeProof;
}

@Injectable()
export class MaxModerationRuleNoticeGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: MaxBotRegistryService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async assertAllowed(
    action: MaxActionJob,
    selectedBotId: string,
    getMemberAccess: MaxModerationRuleNoticeMemberAccessReader,
    beforeFinalAuthority?: () => Promise<void>,
  ): Promise<void> {
    if (!hasMaxModerationRuleNoticeProof(action)) return;
    const proof = readProof(action);
    const followup = readDurableFollowupProof(action);
    if (!selectedBotId.trim()) throw new MaxModerationRuleNoticeRejectedError();
    try {
      await assertModerationRuleSanctionAuthority(this.prisma, proof, {
        isKnownBotUserId: (userId) => this.bots.isKnownBotUserId(userId),
        getMemberAccess: () =>
          getMemberAccess({
            chatId: proof.chatId,
            userId: proof.userId,
            botId: selectedBotId,
            timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
          }),
        consumeImmunity: (input) => this.immunity.consumeForMessage(input),
        beforeFinalAuthority: followup
          ? async () => {
              // FLAG: Route reads precede the bounded SQL fence, so a manual release
              // committed during routing also revokes the queued notice. The generic
              // authority still owns the final settings read and synchronous deadline.
              await beforeFinalAuthority?.();
              await this.assertDurableFollowupNotice(action, proof, followup);
            }
          : beforeFinalAuthority,
        profanityRolloutMode:
          this.config.get<string>('PROFANITY_V2_ROLLOUT_MODE') === 'legacy' ? 'legacy' : 'on',
      });
    } catch (error) {
      if (error instanceof ModerationRuleSanctionRejectedError)
        throw new MaxModerationRuleNoticeRejectedError();
      throw error;
    }
  }

  private async assertDurableFollowupNotice(
    action: MaxActionJob,
    proof: MaxModerationRuleNoticeProof,
    followup: DurableFollowupNoticeProof,
  ): Promise<void> {
    const row = await this.prisma.moderationRuleFollowup.findUnique({
      where: { id: followup.id },
      select: {
        chatId: true,
        messageId: true,
        userId: true,
        reasonKey: true,
        ruleCode: true,
        sourceAt: true,
        deadlineAt: true,
        policySha256: true,
        status: true,
        actionPlan: true,
        effects: true,
      },
    });
    const plan = row?.actionPlan;
    const effects = row?.effects;
    if (
      !row ||
      row.chatId !== proof.chatId ||
      row.messageId !== proof.messageId ||
      row.userId !== proof.userId ||
      row.reasonKey !== proof.reasonKey ||
      row.ruleCode !== proof.ruleCode ||
      row.sourceAt.getTime() + 300_000 !== proof.deadlineAtMs ||
      row.deadlineAt.getTime() !== proof.deadlineAtMs ||
      row.policySha256 !== proof.policySha256 ||
      !['READY', 'IN_PROGRESS', 'RETRYABLE', 'COMPLETED'].includes(row.status) ||
      !plan ||
      typeof plan !== 'object' ||
      Array.isArray(plan) ||
      plan.version !== 1 ||
      plan.issuedAtMs !== followup.issuedAtMs ||
      !['NONE', 'WARN', 'MUTE', 'BAN'].includes(String(plan.action)) ||
      plan.eventId !== `${followup.id}:decision` ||
      plan.noticeKey !== `${followup.id}:sanction-notice` ||
      !effects ||
      typeof effects !== 'object' ||
      Array.isArray(effects) ||
      followup.issuedAtMs < row.sourceAt.getTime() ||
      followup.issuedAtMs > Date.now() ||
      followup.issuedAtMs >= proof.deadlineAtMs
    )
      throw new MaxModerationRuleNoticeRejectedError();
    const matchesSendKey = (logicalKey: string): boolean =>
      [
        logicalKey,
        buildMaxActionIdempotencyKey('explicit', ['SEND_MESSAGE', logicalKey]),
        ...(action.botId
          ? [buildMaxActionIdempotencyKey('explicit', [action.botId, 'SEND_MESSAGE', logicalKey])]
          : []),
      ].includes(action.idempotencyKey);
    const ownExplanation = matchesSendKey(`${followup.id}:explanation`);
    const ownSanction = matchesSendKey(String(plan.noticeKey));
    // FLAG: An explanation proves the deleted violation. A sanction notice additionally
    // needs the saved plan's exact SQL event receipt. Different keys cannot borrow either.
    if (
      (!ownExplanation && !ownSanction) ||
      (ownExplanation &&
        !['UNSTARTED', 'SQL_COMMITTED', 'SETTLED'].includes(
          String(effects.phase ?? 'UNSTARTED'),
        )) ||
      (ownSanction &&
        (!['SQL_COMMITTED', 'SETTLED'].includes(String(effects.phase)) ||
          effects.eventId !== plan.eventId))
    )
      throw new MaxModerationRuleNoticeRejectedError();
    const release = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId: proof.chatId,
        userId: proof.userId,
        ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
        createdAt: { gte: new Date(followup.issuedAtMs) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (release) throw new MaxModerationRuleNoticeRejectedError();
  }
}
