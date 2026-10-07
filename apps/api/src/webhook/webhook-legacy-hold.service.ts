import {
  readFreshHeldCommandReceipt,
  type FreshHeldCommandDatabase,
} from './webhook-legacy-fresh-command';
import {
  materializeLegacyReceiptDisposition,
  type LegacyReceiptDispositionResult,
} from './webhook-legacy-receipt-disposition';
import { Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { MaxUpdate } from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { MaxActionJob } from '../max/max-client.service';
import { materializeSourceAbandonmentReceipt } from './webhook-source-abandonment';
import type { SourceAbandonmentChildKind } from './webhook-source-abandonment.contract';

export type WebhookLegacyHoldDatabase = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export const WEBHOOK_LEGACY_DISPOSITION_VERSION = 1;
export const WEBHOOK_LEGACY_DISPOSITION = 'NO_REPLAY_ORDER_RELEASED';
export const WEBHOOK_LEGACY_HELD_MARKER =
  'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:LEGACY_SCOPE_HELD';

export class WebhookLegacyHoldRejectedError extends Error {
  readonly code = 'webhook_legacy_effect_held';
  constructor() {
    super('Unverified legacy effect requires exact settlement before another action');
  }
}

const protectedProviders = new Set([
  'WebhookService',
  'WebhookCanonicalExecutionService',
  'WebhookOutboxService',
  'GroupCommandAuthorityService',
  'ModerationService',
  'MaxClientService',
  'MaxActionLedgerService',
  'MaxActionDispatchService',
  'ModerationDeleteIntentService',
  'ModerationStateDeleteGuardService',
  'MessageDuplicateDeleteGuardService',
  'MessageDuplicateMediaService',
  'PhotoDuplicateModerationService',
  'CommercialOcrModerationService',
  'ModerationRuleFollowupService',
  'GlobalSpammerIntelligenceService',
  'PrivateControlService',
  'MessageRetentionStore',
  'PublisherChatCommentProducerService',
  'PublisherChatCommentDeliveryService',
]);
const instances = new WeakMap<object, WebhookLegacyHoldService>();

@Injectable()
export class WebhookLegacyHoldService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly modules?: ModulesContainer,
  ) {
    instances.set(prisma, this);
  }

  static forPrisma(prisma: object): WebhookLegacyHoldService | undefined {
    return instances.get(prisma);
  }

  onApplicationBootstrap(): void {
    // FLAG: Optional injection exists for hand-built legacy test fixtures only. Every
    // actual protected production provider must use this authoritative shared reader.
    if (!this.modules) return;
    for (const module of this.modules.values()) {
      for (const wrapper of module.providers.values()) {
        const instance = wrapper.instance as { legacyHolds?: unknown } | undefined;
        if (
          instance &&
          protectedProviders.has(instance.constructor.name) &&
          instance.legacyHolds !== this
        )
          throw new Error(`Mandatory legacy hold reader missing in ${instance.constructor.name}`);
      }
    }
  }

  private async exists(
    sql: Prisma.Sql,
    client: WebhookLegacyHoldDatabase = this.prisma,
  ): Promise<boolean> {
    const rows = await client.$queryRaw<Array<{ held: boolean }>>(sql);
    if (typeof rows[0]?.held !== 'boolean')
      throw new Error('Legacy hold lookup returned no authority');
    return rows[0].held;
  }

  async isMessageHeld(
    chatId: string,
    messageId: string,
    client?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    return this.exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "webhook_legacy_recoveries"
      WHERE "chat_id" = ${chatId} AND "message_id" = ${messageId})
      OR EXISTS (SELECT 1 FROM "webhook_source_abandonments"
      WHERE "chat_id" = ${chatId} AND "message_id" = ${messageId}) AS held`,
      client,
    );
  }
  // FLAG: Modern holds are exact-source only. Never include them in member,
  // global-user, whole-chat or historical-chat-send readers below.
  async isSourceAbandoned(
    chatId: string,
    messageId: string,
    client?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    return this.exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "webhook_source_abandonments"
        WHERE "chat_id" = ${chatId} AND "message_id" = ${messageId}) AS held`,
      client,
    );
  }
  async isSourceChildHeld(
    kind: SourceAbandonmentChildKind,
    childKey: string,
    client?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    return this.exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "webhook_source_child_holds"
        WHERE "kind" = ${kind} AND "child_key" = ${childKey}) AS held`,
      client,
    );
  }
  async hasChatHolds(chatId: string, client?: WebhookLegacyHoldDatabase): Promise<boolean> {
    return this.exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "webhook_legacy_recoveries"
      WHERE "chat_id" = ${chatId}) AS held`,
      client,
    );
  }
  async isMemberHeld(
    chatId: string,
    userId: string,
    client?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    return this.exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "webhook_legacy_recoveries"
      WHERE "chat_id" = ${chatId} AND "user_id" = ${userId}) AS held`,
      client,
    );
  }
  async isGlobalUserHeld(userId: string, client?: WebhookLegacyHoldDatabase): Promise<boolean> {
    return this.exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "webhook_legacy_recoveries"
      WHERE "user_id" = ${userId}) AS held`,
      client,
    );
  }
  // FLAG: A CHAT image match may target a different participant from its original.
  // Read both immutable sources in one bounded indexed query before any new effect.
  async isAnyMessageSourceHeld(
    chatId: string,
    sources: readonly { messageId: string; userId: string }[],
    client?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    if (
      sources.length < 1 ||
      sources.length > 2 ||
      [chatId, ...sources.flatMap((source) => [source.messageId, source.userId])].some(
        (value) => typeof value !== 'string' || !value || value.trim() !== value,
      )
    )
      throw new WebhookLegacyHoldRejectedError();
    return this.exists(
      Prisma.sql`SELECT (
      EXISTS (SELECT 1 FROM "webhook_legacy_recoveries"
        WHERE "chat_id" = ${chatId} AND "message_id" IN (${Prisma.join(sources.map((source) => source.messageId))}))
      OR EXISTS (SELECT 1 FROM "webhook_legacy_recoveries"
        WHERE "user_id" IN (${Prisma.join(sources.map((source) => source.userId))}))
      OR EXISTS (SELECT 1 FROM "webhook_source_abandonments"
        WHERE "chat_id" = ${chatId} AND "message_id" IN (${Prisma.join(sources.map((source) => source.messageId))}))
    ) AS held`,
      client,
    );
  }
  async isOutboundJobHeld(jobKey: string, client?: WebhookLegacyHoldDatabase): Promise<boolean> {
    return this.exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "webhook_legacy_child_holds"
      WHERE "job_key" = ${jobKey}) OR EXISTS (SELECT 1 FROM "webhook_source_child_holds"
      WHERE "kind" = 'MAX_ACTION' AND "child_key" = ${jobKey}) AS held`,
      client,
    );
  }
  async isLegacyChatSendHeld(
    chatId: string,
    jobCreatedAt: Date,
    client?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    const validTime = Number.isFinite(jobCreatedAt.getTime());
    return this.exists(
      Prisma.sql`SELECT EXISTS (
      SELECT 1 FROM "webhook_legacy_recoveries" recovery
      JOIN "webhook_legacy_quiescence_certificates" certificate ON certificate."id" = recovery."certificate_id"
      WHERE recovery."chat_id" = ${chatId}
        ${validTime ? Prisma.sql`AND certificate."quiesced_at" >= ${jobCreatedAt}` : Prisma.empty}
    ) AS held`,
      client,
    );
  }

  async isUpdateHeld(
    update: Pick<MaxUpdate, 'message'>,
    client?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    const message = update.message;
    if (!message?.chatId) return false;
    return this.exists(
      Prisma.sql`SELECT (
      EXISTS (SELECT 1 FROM "webhook_legacy_recoveries" WHERE "chat_id" = ${message.chatId} AND "message_id" = ${message.messageId ?? ''})
      OR EXISTS (SELECT 1 FROM "webhook_legacy_recoveries" WHERE "user_id" = ${message.senderId ?? ''})
      OR EXISTS (SELECT 1 FROM "webhook_source_abandonments" WHERE "chat_id" = ${message.chatId} AND "message_id" = ${message.messageId ?? ''})
    ) AS held`,
      client,
    );
  }

  async assertUpdateAllowed(
    update: Pick<MaxUpdate, 'message'>,
    client?: WebhookLegacyHoldDatabase,
  ): Promise<void> {
    if (await this.isUpdateHeld(update, client)) throw new WebhookLegacyHoldRejectedError();
  }

  readFreshCommandReceipt(
    webhookEventId: string,
    expectedUpdate?: MaxUpdate,
    client: FreshHeldCommandDatabase = this.prisma,
  ) {
    return readFreshHeldCommandReceipt(client, webhookEventId, expectedUpdate);
  }

  async materializeReceipt(
    webhookEventId: string,
    client?: Prisma.TransactionClient,
  ): Promise<LegacyReceiptDispositionResult> {
    const materialize = async (tx: Prisma.TransactionClient) => {
      const modern = await materializeSourceAbandonmentReceipt(tx, webhookEventId);
      return modern === 'NOT_HELD'
        ? materializeLegacyReceiptDisposition(tx, webhookEventId)
        : modern;
    };
    return client ? materialize(client) : this.prisma.$transaction(materialize);
  }

  async settleHeldReceipt(
    webhookEventId: string,
    _update: Pick<MaxUpdate, 'message'>,
  ): Promise<boolean> {
    const result = await this.materializeReceipt(webhookEventId);
    return result === 'APPLIED_WITH_PROOF' || result === 'ALREADY_APPLIED_SAME_PROOF';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type LegacyActionSourceScope = {
  chatId: string;
  messageId?: string;
  userId?: string;
  exactMessageOnly?: true;
};

// FLAG: Read every proof independently. A valid first envelope cannot mask a held
// source in another envelope; duplicate notices keep chat outside their v3 binding.
export function readLegacyActionSourceScopes(job: MaxActionJob): LegacyActionSourceScope[] {
  const readIdentity = (values: unknown[]): string | undefined => {
    const identities = values.filter((value) => value !== undefined && value !== null);
    if (
      identities.some(
        (value) => typeof value !== 'string' || !value.trim() || value !== value.trim(),
      )
    )
      throw new WebhookLegacyHoldRejectedError();
    const unique = [...new Set(identities as string[])];
    if (unique.length > 1) throw new WebhookLegacyHoldRejectedError();
    return unique[0];
  };
  const chatId = readIdentity([job.chatId]);
  if (!chatId) throw new WebhookLegacyHoldRejectedError();
  const scopes: LegacyActionSourceScope[] = [
    { chatId, messageId: readIdentity([job.messageId]), userId: readIdentity([job.userId]) },
  ];
  if (job.options?.messageLink) {
    const link = job.options.messageLink;
    if (link.type !== 'reply' || !readIdentity([link.mid]))
      throw new WebhookLegacyHoldRejectedError();
    scopes.push({ chatId, messageId: readIdentity([link.mid]), exactMessageOnly: true });
  }
  if (job.sendAutoDelete) {
    const marker = object(job.sendAutoDelete);
    if (!marker || !readIdentity([marker.sourceSendJobId]))
      throw new WebhookLegacyHoldRejectedError();
    const keys = ['sourceChatId', 'sourceUserId', 'sourceMessageId', 'sourceCreatedAt'];
    if (keys.some((key) => Object.hasOwn(marker, key))) {
      // FLAG: Derived DELETE jobs retain the exact original SEND source. A partial
      // envelope cannot borrow the new remote message identity or child creation time.
      if (
        !keys.every((key) => Object.hasOwn(marker, key)) ||
        readIdentity([marker.sourceChatId]) !== chatId ||
        typeof marker.sourceCreatedAt !== 'string' ||
        !Number.isFinite(Date.parse(marker.sourceCreatedAt)) ||
        marker.sourceCreatedAt !== marker.sourceCreatedAt.trim() ||
        (marker.sourceUserId !== null && !readIdentity([marker.sourceUserId])) ||
        (marker.sourceMessageId !== null && !readIdentity([marker.sourceMessageId]))
      )
        throw new WebhookLegacyHoldRejectedError();
      const messageId = readIdentity([marker.sourceMessageId]);
      const userId = readIdentity([marker.sourceUserId]);
      if (messageId || userId) scopes.push({ chatId, messageId, userId });
    }
  }
  const context = object(job.ledgerContext);
  for (const key of [
    'moderationSource',
    'moderationRuleNotice',
    'requiredSubscriptionNotice',
    'duplicateNotice',
  ]) {
    if (!context || !Object.hasOwn(context, key)) continue;
    const proof = object(context[key]);
    const binding = key === 'duplicateNotice' ? object(proof?.binding) : null;
    if (!proof || (key === 'duplicateNotice' && !binding))
      throw new WebhookLegacyHoldRejectedError();
    scopes.push({
      chatId: readIdentity([proof.chatId, binding?.chatId]) ?? chatId,
      messageId: readIdentity([proof.messageId, binding?.messageId]),
      userId: readIdentity([
        proof.userId,
        proof.subjectUserId,
        proof.senderId,
        binding?.userId,
        binding?.subjectUserId,
        binding?.senderId,
      ]),
    });
  }
  return scopes;
}

// FLAG: Exact child IDs supplement scope protection; job-created clocks alone can be
// future-dated. This guard never settles receipts; callers recover confirmed receipts first.
export async function assertLegacyActionAllowed(
  holds: WebhookLegacyHoldService,
  job: MaxActionJob,
  client?: WebhookLegacyHoldDatabase,
): Promise<void> {
  if (await holds.isOutboundJobHeld(job.idempotencyKey, client))
    throw new WebhookLegacyHoldRejectedError();
  const scopes = readLegacyActionSourceScopes(job);
  if (job.sendAutoDelete) {
    // FLAG: Existing v1/v2 children may lack the additive source envelope. Exact
    // parent holds still apply; an absent source clock never proves a post-seal SEND.
    if (
      (await holds.isOutboundJobHeld(job.sendAutoDelete.sourceSendJobId, client)) ||
      (await holds.isLegacyChatSendHeld(
        job.chatId,
        new Date(job.sendAutoDelete.sourceCreatedAt ?? NaN),
        client,
      ))
    )
      throw new WebhookLegacyHoldRejectedError();
  }
  for (const [index, scope] of scopes.entries()) {
    if (
      index > 0 &&
      !scope.exactMessageOnly &&
      (!scope.messageId || !scope.userId) &&
      ((await holds.isLegacyChatSendHeld(job.chatId, new Date(NaN), client)) ||
        (await holds.isLegacyChatSendHeld(scope.chatId, new Date(NaN), client)))
    )
      throw new WebhookLegacyHoldRejectedError();
    if (scope.messageId && (await holds.isMessageHeld(scope.chatId, scope.messageId, client)))
      throw new WebhookLegacyHoldRejectedError();
    if (
      scope.userId &&
      ((await holds.isMemberHeld(scope.chatId, scope.userId, client)) ||
        (await holds.isGlobalUserHeld(scope.userId, client)))
    )
      throw new WebhookLegacyHoldRejectedError();
  }
  if (
    job.actionType === 'SEND_MESSAGE' &&
    (await holds.isLegacyChatSendHeld(job.chatId, new Date(job.createdAt), client))
  )
    throw new WebhookLegacyHoldRejectedError();
}

// FLAG: Ordered-head readers skip only a versioned sealed disposition. Scope hold
// readers above deliberately do not depend on seal/version, so partial installation fails closed.
export function legacyOrderReleasedSql(eventAlias: string): Prisma.Sql {
  if (!/^[a-z_]+$/u.test(eventAlias)) throw new Error('Invalid webhook SQL alias');
  return Prisma.sql`(${Prisma.raw(eventAlias)}."legacy_disposition_id" IS NOT NULL
    OR ${Prisma.raw(eventAlias)}."source_disposition_id" IS NOT NULL)`;
}

export function legacyUpdateHeldSql(eventAlias: string): Prisma.Sql {
  if (!/^[a-z_]+$/u.test(eventAlias)) throw new Error('Invalid webhook SQL alias');
  const event = Prisma.raw(eventAlias);
  return Prisma.sql`(${legacyScopeSql(eventAlias, false)} OR EXISTS (
    SELECT 1 FROM "webhook_source_abandonments" source
    WHERE source."chat_id" = ${event}."normalized_payload"->'message'->>'chatId'
      AND source."message_id" = ${event}."normalized_payload"->'message'->>'messageId'))`;
}

export function legacyReceiptBornAfterSealSql(eventAlias: string): Prisma.Sql {
  return legacyScopeSql(eventAlias, true, true);
}

function legacyScopeSql(eventAlias: string, released: boolean, afterSeal = false): Prisma.Sql {
  if (!/^[a-z_]+$/u.test(eventAlias)) throw new Error('Invalid webhook SQL alias');
  const event = Prisma.raw(eventAlias);
  const sealed = Prisma.sql`recovery."authority_version" = 1 AND recovery."disposition" = 'NO_REPLAY_ORDER_RELEASED'
      AND certificate."authority_version" = 1 AND certificate."sealed_at" IS NOT NULL`;
  const scope = (predicate: Prisma.Sql) => Prisma.sql`EXISTS (
    SELECT 1 FROM "webhook_legacy_recoveries" recovery
    JOIN "webhook_legacy_quiescence_certificates" certificate ON certificate."id" = recovery."certificate_id"
    WHERE ${predicate} ${released ? Prisma.sql`AND ${sealed}` : Prisma.empty}
      ${afterSeal ? Prisma.sql`AND certificate."sealed_at" < ${event}."created_at"` : Prisma.empty})`;
  return Prisma.sql`(
    ${scope(Prisma.sql`recovery."semantic_key" = ${event}."semantic_key"`)}
    OR ${scope(Prisma.sql`recovery."chat_id" = ${event}."normalized_payload"->'message'->>'chatId'
      AND recovery."message_id" = ${event}."normalized_payload"->'message'->>'messageId'`)}
    OR ${scope(Prisma.sql`recovery."user_id" = ${event}."normalized_payload"->'message'->>'senderId'`)}
  )`;
}
