import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  messageRetentionStateSchema,
  type MessageRetentionState,
  type UpdateMessageRetention,
} from '@maxim/contracts/settings';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole } from '../runtime/app-role';
import type { NetworkSettingsWriteOptions } from '../admin/network-settings-write';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { buildBotIdVariants } from '../max/max-bot-config.util';
import { protectionEvidence, protectionEvidencePage } from './eraser-protection-provenance';
import {
  retentionProtectionReportSchema,
  type RetentionProtectionReport,
} from '@maxim/contracts/safety-desk';

// FLAG: A reader with this version must keep the persisted ownership fence, even with the flag off.
export const ERASER_OWNERSHIP_VERSION = 1;
// FLAG: Pending activation remains visible and cancellable across compatible API releases.
export const ERASER_CONNECTION_REQUEST_VERSION = 1;
const PAGE_SIZE = 500;
const BOT_PAGE_SIZE = 250;
const REQUEST_TIMEOUT_MS = 10_000;

type StoredOperation = {
  id: string;
  chatId: string;
  actorUserId: string;
  request: UpdateMessageRetention & { operationId: string };
  result: unknown;
};
type OutboxRow = {
  chatId: string;
  revision: number;
  deliveredRevision: number;
  bootstrapCursor: string | null;
  bootstrapComplete: boolean;
  rulesAuditAt: Date | null;
  rulesAuditId: string | null;
  rulesAuditComplete: boolean;
  giveawayAuditAt: Date | null;
  giveawayAuditId: string | null;
  giveawayAuditComplete: boolean;
  holdCursor: string | null;
  holdsComplete: boolean;
  sourceCursor: string | null;
  sourceStage: number;
};

@Injectable()
export class EraserControlService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EraserControlService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly bots?: MaxBotRegistryService,
  ) {}

  get enabled(): boolean {
    return this.config.get<boolean>('ERASER_ENABLED', false) === true;
  }

  async onModuleInit(): Promise<void> {
    if (!this.readAvailable || !['admin', 'all'].includes(getAppRole())) return;
    if (this.enabled || (await this.hasOwned())) this.schedule();
  }

  get readAvailable(): boolean {
    return Boolean(
      this.config.get<string>('ERASER_CONTROL_URL') &&
      this.config.get<string>('ERASER_CONTROL_TOKEN'),
    );
  }

  private assertExecution(): void {
    if (!this.enabled)
      throw new ServiceUnavailableException('Управление Ластиком временно недоступно.');
  }

  private async hasOwned(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ owned: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM eraser_chat_bindings LIMIT 1) AS owned`;
    return rows[0]?.owned === true;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.syncDue()
        .catch(() =>
          this.logger.warn({ code: 'ERASER_PROTECTION_SYNC_FAILED' }, 'Protection sync deferred'),
        )
        .finally(() => {
          this.inFlight = null;
          this.schedule();
        });
    }, 1_000);
    this.timer.unref?.();
  }

  async owns(chatId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ owned: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM eraser_chat_bindings WHERE chat_id = ${chatId}) AS owned`;
    return rows[0]?.owned === true;
  }

  async request(
    path: string,
    method = 'GET',
    body?: unknown,
    authority: 'control' | 'protection' = 'control',
  ): Promise<unknown> {
    if (authority === 'protection') {
      const chat = /^\/chats\/(-[1-9]\d*)\/(bootstrap|protection)$/.exec(path);
      if (method !== 'PUT' || (!chat && path !== '/holds'))
        throw new ServiceUnavailableException('Недопустимая операция синхронизации защиты.');
      // FLAG: Existing ownership permits conservative protection delivery with execution off.
      // This transport can neither activate policies nor reopen an attempted DELETE.
      if (!this.enabled && !(chat ? await this.owns(chat[1]!) : await this.hasOwned()))
        throw new ServiceUnavailableException('Ластик не управляет этим источником.');
    } else if (method !== 'GET') this.assertExecution();
    const origin = this.config.get<string>('ERASER_CONTROL_URL');
    const token = this.config.get<string>('ERASER_CONTROL_TOKEN');
    if (!origin || !token) throw new ServiceUnavailableException('Ластик временно недоступен.');
    let response: Response;
    try {
      response = await fetch(`${origin.replace(/\/$/, '')}/internal/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Ответ Ластика не получен. Проверьте состояние перед повтором.',
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ServiceUnavailableException('Не удалось прочитать ответ Ластика.');
    }
    if (response.status === 409) {
      const code = value && typeof value === 'object' && 'code' in value ? value.code : null;
      const conflicts: Record<string, string> = {
        MESSAGE_RETENTION_REVISION_CONFLICT: 'Состояние Ластика изменилось. Обновите настройки.',
        ERASER_CONNECTION_REQUIRED: 'Добавьте Ластика администратором с правами чтения и удаления.',
        ERASER_OPERATION_CONFLICT: 'Идентификатор сохранения уже использован для других настроек.',
        ERASER_PROTECTION_PENDING:
          'Ластик подготавливает защиту правил и розыгрышей. Повторите сохранение после синхронизации.',
        ERASER_PROTECTION_REVISION_CONFLICT:
          'Список защищённых сообщений изменился. Синхронизация будет повторена.',
        ERASER_HOLD_EFFECT_PENDING: 'Неопределённый результат удаления требует проверки.',
        ERASER_RETRY_CONFLICT: 'Состояние удаления изменилось. Обновите список.',
        ERASER_REVIEW_CONFLICT: 'Настройки изменились. Обновите список.',
      };
      const safeCode =
        typeof code === 'string' && Object.hasOwn(conflicts, code) ? code : 'ERASER_CONFLICT';
      throw new ConflictException({
        code: safeCode,
        message: conflicts[safeCode] ?? 'Операция Ластика требует обновления состояния.',
      });
    }
    if ([400, 403, 422].includes(response.status))
      throw new BadRequestException(
        'Проверьте подключение Ластика, права администратора и состояние синхронизации.',
      );
    if (!response.ok) throw new ServiceUnavailableException('Ластик временно недоступен.');
    return value;
  }

  async read(chatId: string): Promise<MessageRetentionState> {
    return this.readState(chatId, false);
  }

  async protectionReport(chatId: string): Promise<RetentionProtectionReport> {
    // FLAG: Closed detail reads use exact primary keys. Fleet polling does not run this query per chat.
    const [row] = await this.prisma.$queryRaw<
      {
        revision: number;
        deliveredRevision: number;
        createdAt: Date;
        giveawayEntities: boolean;
        rulesAudit: boolean;
        giveawayAudit: boolean;
        legacyHolds: boolean;
        sourceHolds: boolean;
        evidenceReady: boolean;
        references: bigint;
        evidence: unknown;
        retirementPresent: boolean;
        scanComplete: boolean;
        retired: bigint | null;
        reconciliation: bigint | null;
        retained: bigint | null;
      }[]
    >`
      SELECT outbox.revision, outbox.delivered_revision AS "deliveredRevision", binding.created_at AS "createdAt",
        bootstrap_complete AS "giveawayEntities", rules_audit_complete AS "rulesAudit", giveaway_audit_complete AS "giveawayAudit",
        holds_complete AS "legacyHolds", source_stage=3 AS "sourceHolds",
        evidence_revision=outbox.revision AND evidence_stage=2 AS "evidenceReady", evidence_count AS "references",
        delivered_evidence AS evidence, retirement.chat_id IS NOT NULL AS "retirementPresent",
        retirement.completed_at IS NOT NULL AS "scanComplete", retired_count AS retired,
        reconciliation_count AS reconciliation, retained_count AS retained
      FROM eraser_chat_bindings binding JOIN eraser_protection_outbox outbox ON outbox.chat_id=binding.chat_id
      LEFT JOIN eraser_legacy_retirement retirement ON retirement.chat_id=binding.chat_id
      WHERE binding.chat_id=${chatId}`;
    if (!row) return { status: 'unavailable' };
    return retentionProtectionReportSchema.parse({
      status: 'available',
      sourceRevision: row.revision,
      deliveredRevision: row.deliveredRevision,
      historicalGapBefore: row.createdAt.toISOString(),
      imports: {
        giveawayEntities: row.giveawayEntities,
        rulesAudit: row.rulesAudit,
        giveawayAudit: row.giveawayAudit,
        legacyHolds: row.legacyHolds,
        sourceHolds: row.sourceHolds,
      },
      catalog: { ready: row.evidenceReady, referencesHashed: Number(row.references) },
      deliveredEvidence: row.evidence as Extract<
        RetentionProtectionReport,
        { status: 'available' }
      >['deliveredEvidence'],
      legacyRetirement: row.retirementPresent
        ? {
            scanComplete: row.scanComplete,
            retiredCount: Number(row.retired),
            reconciliationCount: Number(row.reconciliation),
            retainedAtScan: Number(row.retained),
          }
        : null,
    });
  }

  private async readState(
    chatId: string,
    initializeOwned: boolean,
  ): Promise<MessageRetentionState> {
    const path = `/chats/${encodeURIComponent(chatId)}`;
    let value = await this.request(`${path}/policy`);
    if (
      value &&
      typeof value === 'object' &&
      'initialized' in value &&
      value.initialized === false
    ) {
      // FLAG: A lost source for a persisted owner is unavailable, never a fresh disabled policy.
      if (!initializeOwned && (await this.owns(chatId)))
        throw new ServiceUnavailableException('Сохранённые настройки Ластика пока недоступны.');
      this.assertExecution();
      const old = await this.prisma.messageRetentionPolicy.findUnique({
        where: { chatId },
        select: { hours: true },
      });
      await this.request(`${path}/bootstrap`, 'PUT', {
        hours: old?.hours === 24 ? 24 : old?.hours === 168 ? 168 : 48,
      });
      value = await this.request(`${path}/policy`);
      if (
        value &&
        typeof value === 'object' &&
        'initialized' in value &&
        value.initialized === false
      )
        throw new ServiceUnavailableException('Настройки Ластика ещё не подтверждены.');
    }
    return messageRetentionStateSchema.parse(value);
  }

  async resume(
    chatId: string,
    actorUserId: string,
    operationId: string,
    options?: NetworkSettingsWriteOptions,
  ): Promise<MessageRetentionState | null> {
    const saved = await this.operation(operationId);
    if (!saved) return null;
    if (saved.chatId !== chatId || saved.actorUserId !== actorUserId)
      throw new ConflictException('Операция относится к другому запросу.');
    return this.dispatch(saved, options);
  }

  async update(
    chatId: string,
    actorUserId: string,
    input: UpdateMessageRetention,
    options?: NetworkSettingsWriteOptions,
  ): Promise<MessageRetentionState> {
    this.assertExecution();
    if (options?.validateOnly) {
      const current = await this.read(chatId);
      if (current.revision !== input.expectedRevision)
        throw new ConflictException('Настройки удаления сообщений уже изменены.');
      return current;
    }
    const request = { ...input, operationId: input.operationId ?? randomUUID() };
    // FLAG: Persist the exact request before crossing the database boundary. A timeout reuses this ID.
    await this.prisma.$executeRaw`
      INSERT INTO eraser_control_operations(id, chat_id, actor_user_id, request)
      VALUES(${request.operationId}, ${chatId}, ${actorUserId}, ${JSON.stringify(request)}::jsonb)
      ON CONFLICT (id) DO NOTHING`;
    const saved = await this.operation(request.operationId);
    if (
      !saved ||
      saved.chatId !== chatId ||
      saved.actorUserId !== actorUserId ||
      JSON.stringify(canonicalRequest(saved.request)) !== JSON.stringify(canonicalRequest(request))
    )
      throw new ConflictException('Идентификатор операции уже использован для других настроек.');
    return this.dispatch(saved, options);
  }

  private async operation(id: string): Promise<StoredOperation | null> {
    const rows = await this.prisma.$queryRaw<StoredOperation[]>`
      SELECT id, chat_id AS "chatId", actor_user_id AS "actorUserId", request, result
      FROM eraser_control_operations WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  private async dispatch(
    operation: StoredOperation,
    options?: NetworkSettingsWriteOptions,
  ): Promise<MessageRetentionState> {
    if (operation.result) {
      const result = messageRetentionStateSchema.parse(operation.result);
      if (options?.onCommitted)
        await this.prisma.$transaction(async (tx) => {
          await options.onCommitted!(tx, String(result.revision));
        });
      return result;
    }
    this.assertExecution();
    if (options?.beforeWrite) await this.prisma.$transaction(options.beforeWrite);
    await this.takeOwnership(operation.chatId);
    await this.readState(operation.chatId, true);
    // A bounded pass may leave a large bootstrap incomplete. The same operation is safe to retry.
    await this.syncChat(operation.chatId);
    await this.syncGlobalHolds();
    if (operation.request.enabled) {
      const [ready] = await this.prisma.$queryRaw<{ ready: boolean }[]>`
        SELECT (local.bootstrap_complete AND local.rules_audit_complete AND local.holds_complete AND local.source_stage = 3 AND local.delivered_revision = local.revision
          AND global_state.bootstrap_complete AND NOT EXISTS(SELECT 1 FROM eraser_held_authors WHERE delivered = FALSE LIMIT 1)) AS ready
        FROM eraser_protection_outbox local CROSS JOIN eraser_global_hold_state global_state WHERE local.chat_id = ${operation.chatId} AND global_state.id = 1`;
      if (!ready?.ready)
        throw new ServiceUnavailableException(
          'Ластик готовит список защищённых сообщений. Повторите сохранение после синхронизации.',
        );
    }
    if (options?.beforeWrite) await this.prisma.$transaction(options.beforeWrite);
    const state = messageRetentionStateSchema.parse(
      await this.request(`/chats/${encodeURIComponent(operation.chatId)}/policy`, 'PUT', {
        ...operation.request,
        actorUserId: operation.actorUserId,
      }),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE eraser_control_operations SET result = ${JSON.stringify(state)}::jsonb, confirmed_at = CURRENT_TIMESTAMP WHERE id = ${operation.id}`;
      await tx.auditLog.create({
        data: {
          chatId: operation.chatId,
          actorUserId: operation.actorUserId,
          action: 'UPDATE_MESSAGE_RETENTION',
          payload: { ...operation.request, executor: 'eraser', revision: state.revision },
        },
      });
      await options?.onCommitted?.(tx, String(state.revision));
    });
    return state;
  }

  private async takeOwnership(chatId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
      const old = await tx.messageRetentionPolicy.findUnique({
        where: { chatId },
        select: { hours: true },
      });
      const inserted = await tx.$executeRaw`
        INSERT INTO eraser_chat_bindings(chat_id, legacy_hours) VALUES(${chatId}, ${old?.hours === 24 ? 24 : old?.hours === 168 ? 168 : 48}) ON CONFLICT DO NOTHING`;
      if (!inserted) return;
      for (const botId of this.bots?.getKnownBotUserIdVariants() ?? [])
        await this.protectBot(tx, chatId, botId);
      // FLAG: End legacy authority before exporting any candidate. Journals and unknown effects remain intact.
      await tx.messageRetentionPolicy.updateMany({
        where: { chatId },
        data: {
          enabled: false,
          activationId: randomUUID(),
          captureAfter: null,
          revision: { increment: 1 },
          nextRunAt: new Date(),
          lastStatus: 'off',
        },
      });
      await tx.$executeRaw`INSERT INTO eraser_protection_outbox(chat_id) VALUES(${chatId}) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO eraser_legacy_retirement(chat_id) VALUES(${chatId}) ON CONFLICT DO NOTHING`;
    });
  }

  async syncDue(): Promise<void> {
    await this.syncGlobalHolds();
    const deadline = Date.now() + 15_000;
    const rows = await this.prisma.$queryRaw<{ chatId: string }[]>`
      SELECT chat_id AS "chatId" FROM eraser_protection_outbox
      WHERE next_attempt_at <= CURRENT_TIMESTAMP AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP)
      ORDER BY next_attempt_at, chat_id LIMIT 20`;
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      try {
        await this.syncChat(row.chatId);
      } catch {
        this.logger.warn(
          { code: 'ERASER_CHAT_PROTECTION_SYNC_DEFERRED', chatId: row.chatId },
          'Protection delivery awaits retry',
        );
      }
    }
  }

  async syncChat(chatId: string): Promise<void> {
    const token = randomUUID();
    const rows = await this.prisma.$queryRaw<OutboxRow[]>`
      UPDATE eraser_protection_outbox SET lease_token = ${token}, lease_until = CURRENT_TIMESTAMP + INTERVAL '30 seconds'
      WHERE chat_id = ${chatId} AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP)
      RETURNING chat_id AS "chatId", revision, delivered_revision AS "deliveredRevision", bootstrap_cursor AS "bootstrapCursor", bootstrap_complete AS "bootstrapComplete", rules_audit_at AS "rulesAuditAt", rules_audit_id AS "rulesAuditId", rules_audit_complete AS "rulesAuditComplete", giveaway_audit_at AS "giveawayAuditAt", giveaway_audit_id AS "giveawayAuditId", giveaway_audit_complete AS "giveawayAuditComplete", hold_cursor AS "holdCursor", holds_complete AS "holdsComplete", source_cursor AS "sourceCursor", source_stage AS "sourceStage"`;
    const outbox = rows[0];
    if (!outbox) return;
    try {
      if (
        !outbox.bootstrapComplete ||
        !outbox.rulesAuditComplete ||
        !outbox.giveawayAuditComplete ||
        !outbox.holdsComplete ||
        outbox.sourceStage < 3
      ) {
        await this.bootstrapPage(outbox, token);
        return;
      }
      const cutoff = new Date(Date.now() - 60_000);
      const messages = await this.prisma.$queryRaw<{ messageId: string; held: boolean }[]>`
        SELECT message_id AS "messageId", held FROM eraser_protected_messages
        WHERE chat_id = ${chatId} AND delivered = FALSE ORDER BY message_id LIMIT ${PAGE_SIZE}`;
      const protectedBots = await this.prisma.$queryRaw<{ botId: string }[]>`
        SELECT bot_id AS "botId" FROM eraser_protected_bots WHERE chat_id = ${chatId} AND delivered = FALSE ORDER BY bot_id LIMIT ${BOT_PAGE_SIZE}`;
      const [binding] = await this.prisma.$queryRaw<{ hours: number; createdAt: Date }[]>`
        SELECT legacy_hours AS hours, created_at AS "createdAt" FROM eraser_chat_bindings WHERE chat_id = ${chatId}`;
      const catalog = await this.prisma.$transaction((tx) =>
        protectionEvidencePage(tx, chatId, token),
      );
      const complete =
        messages.length < PAGE_SIZE &&
        protectedBots.length < BOT_PAGE_SIZE &&
        catalog?.revision === outbox.revision;
      const guards = complete
        ? await this.prisma.$queryRaw<{ earliest: Date | null }[]>`
        SELECT started_at AS earliest FROM eraser_publication_fences
        WHERE chat_id = ${chatId} ORDER BY started_at LIMIT 1`
        : [];
      const earliest = guards[0]?.earliest;
      const through = earliest
        ? new Date(Math.min(cutoff.getTime(), earliest.getTime() - 1))
        : cutoff;
      const evidence =
        complete && binding && catalog
          ? protectionEvidence(chatId, outbox.revision, binding.createdAt, through, catalog)
          : null;
      if (outbox.deliveredRevision < 0) {
        await this.request(
          `/chats/${encodeURIComponent(chatId)}/bootstrap`,
          'PUT',
          {
            hours: binding?.hours ?? 48,
          },
          'protection',
        );
      }
      // FLAG: Incomplete pages invalidate the watermark. Only a complete, stable source revision seals it.
      await this.request(
        `/chats/${encodeURIComponent(chatId)}/protection`,
        'PUT',
        {
          sourceRevision: outbox.revision,
          protectedMessageIds: messages.filter((row) => !row.held).map((row) => row.messageId),
          holdMessageIds: messages.filter((row) => row.held).map((row) => row.messageId),
          protectedBotIds: [
            ...new Set(protectedBots.flatMap((row) => [...buildBotIdVariants(row.botId)])),
          ],
          botHistoryCompleteFrom: binding?.createdAt.toISOString() ?? null,
          complete,
          completeThrough: complete ? through.toISOString() : null,
          ...(evidence ? { evidence } : {}),
        },
        'protection',
      );
      if (messages.length)
        await this.prisma.$executeRaw(Prisma.sql`
        UPDATE eraser_protected_messages AS protected SET delivered = TRUE
        FROM (VALUES ${Prisma.join(messages.map((row) => Prisma.sql`(${row.messageId}::text, ${row.held}::boolean)`))}) AS sent(message_id, held)
        WHERE protected.chat_id = ${chatId} AND protected.message_id = sent.message_id AND protected.held = sent.held
          AND EXISTS(SELECT 1 FROM eraser_protection_outbox WHERE chat_id = ${chatId} AND revision = ${outbox.revision} AND lease_token = ${token})`);
      if (protectedBots.length)
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE eraser_protected_bots SET delivered = TRUE WHERE chat_id = ${chatId} AND bot_id IN (${Prisma.join(protectedBots.map((row) => row.botId))})
            AND EXISTS(SELECT 1 FROM eraser_protection_outbox WHERE chat_id = ${chatId} AND revision = ${outbox.revision} AND lease_token = ${token})`);
      await this.prisma.$executeRaw`
        UPDATE eraser_protection_outbox SET delivered_revision = CASE WHEN ${complete} THEN revision ELSE delivered_revision END,
          delivered_evidence = CASE WHEN ${complete} THEN ${JSON.stringify(evidence)}::jsonb ELSE delivered_evidence END,
          next_attempt_at = CURRENT_TIMESTAMP + ${complete ? 600_000 : 100} * INTERVAL '1 millisecond'
        WHERE chat_id = ${chatId} AND revision = ${outbox.revision} AND lease_token = ${token}`;
    } finally {
      await this.prisma
        .$executeRaw`UPDATE eraser_protection_outbox SET lease_token = NULL, lease_until = NULL,
        next_attempt_at = GREATEST(next_attempt_at, CURRENT_TIMESTAMP + INTERVAL '1 second') WHERE chat_id = ${chatId} AND lease_token = ${token}`.catch(
        () =>
          this.logger.warn(
            { code: 'ERASER_PROTECTION_LEASE_RELEASE_DEFERRED', chatId },
            'Protection lease awaits expiry',
          ),
      );
    }
  }

  private async bootstrapPage(outbox: OutboxRow, token: string): Promise<void> {
    const chatId = outbox.chatId;
    await this.prisma.$transaction(async (tx) => {
      // FLAG: Bootstrap cannot reinstall a stale publication fence after its producer cleared it.
      await tx.$queryRaw`SELECT id FROM chat_rules WHERE chat_id = ${chatId} FOR UPDATE`;
      const rules = await tx.chatRules.findUnique({
        where: { chatId },
        select: {
          id: true,
          publishedMessageId: true,
          pendingCleanupMessageId: true,
          publishSendStartedAt: true,
          publishedBotId: true,
          pendingCleanupBotId: true,
        },
      });
      for (const messageId of [rules?.publishedMessageId, rules?.pendingCleanupMessageId])
        if (messageId) await this.protect(tx, chatId, messageId, false);
      for (const botId of [rules?.publishedBotId, rules?.pendingCleanupBotId])
        if (botId) await this.protectBot(tx, chatId, botId);
      if (rules?.publishSendStartedAt)
        await this.fence(tx, chatId, `chat_rules:${rules.id}`, rules.publishSendStartedAt);
      if (!outbox.bootstrapComplete) {
        const giveaways = await tx.$queryRaw<
          {
            id: string;
            publicationMessageId: string | null;
            resultsMessageId: string | null;
            lockedAt: Date | null;
            publicationBotId: string | null;
            resultsBotId: string | null;
          }[]
        >`
          SELECT id, publication_message_id AS "publicationMessageId", results_message_id AS "resultsMessageId", locked_at AS "lockedAt", publication_bot_id AS "publicationBotId", results_bot_id AS "resultsBotId"
          FROM managed_giveaways WHERE source_chat_id = ${chatId} AND id > ${outbox.bootstrapCursor ?? ''}
          ORDER BY id LIMIT ${PAGE_SIZE} FOR UPDATE`;
        for (const giveaway of giveaways)
          for (const botId of [giveaway.publicationBotId, giveaway.resultsBotId])
            if (botId) await this.protectBot(tx, chatId, botId);
        for (const giveaway of giveaways)
          for (const messageId of [giveaway.publicationMessageId, giveaway.resultsMessageId])
            if (messageId) await this.protect(tx, chatId, messageId, false);
        for (const giveaway of giveaways)
          if (giveaway.lockedAt)
            await this.fence(tx, chatId, `managed_giveaways:${giveaway.id}`, giveaway.lockedAt);
        await tx.$executeRaw`UPDATE eraser_protection_outbox SET bootstrap_cursor = ${giveaways.at(-1)?.id ?? outbox.bootstrapCursor}, bootstrap_complete = ${giveaways.length < PAGE_SIZE} WHERE chat_id = ${chatId} AND lease_token = ${token}`;
      }
      if (!outbox.rulesAuditComplete) {
        const audit = await tx.$queryRaw<{ id: string; createdAt: Date; payload: unknown }[]>`
          SELECT id, created_at AS "createdAt", payload FROM audit_logs
          WHERE chat_id = ${chatId} AND action IN ('ADOPT_CHAT_RULES_MESSAGE', 'PUBLISH_CHAT_RULES', 'RESET_CHAT_RULES_PUBLICATION')
            AND (created_at, id) > (${outbox.rulesAuditAt ?? new Date(0)}, ${outbox.rulesAuditId ?? ''})
          ORDER BY created_at, id LIMIT ${PAGE_SIZE}`;
        for (const row of audit) {
          const payload =
            row.payload && typeof row.payload === 'object'
              ? (row.payload as Record<string, unknown>)
              : {};
          for (const key of [
            'messageId',
            'previousPublishedMessageId',
            'preservedCleanupMessageId',
          ])
            if (typeof payload[key] === 'string' && payload[key])
              await this.protect(tx, chatId, payload[key], false);
          for (const key of ['botId', 'previousPublishedBotId'])
            if (typeof payload[key] === 'string' && payload[key])
              await this.protectBot(tx, chatId, payload[key]);
        }
        await tx.$executeRaw`UPDATE eraser_protection_outbox SET rules_audit_at = ${audit.at(-1)?.createdAt ?? outbox.rulesAuditAt}, rules_audit_id = ${audit.at(-1)?.id ?? outbox.rulesAuditId}, rules_audit_complete = ${audit.length < PAGE_SIZE} WHERE chat_id = ${chatId} AND lease_token = ${token}`;
      }
      if (!outbox.giveawayAuditComplete) {
        // FLAG: Exact audit references survive entity deletion. Missing results history remains a gap.
        const audit = await tx.$queryRaw<
          { id: string; createdAt: Date; messageId: string | null; botId: string | null }[]
        >`
          SELECT id, created_at AS "createdAt",
            CASE WHEN jsonb_typeof(payload->'publicationMessageId')='string' AND length(payload->>'publicationMessageId') BETWEEN 1 AND 256 THEN payload->>'publicationMessageId' END AS "messageId",
            CASE WHEN jsonb_typeof(payload->'publicationBotId')='string' AND length(payload->>'publicationBotId') BETWEEN 1 AND 256 THEN payload->>'publicationBotId' END AS "botId"
          FROM audit_logs WHERE chat_id=${chatId} AND action='PUBLISH_GIVEAWAY'
            AND (created_at,id) > (${outbox.giveawayAuditAt ?? new Date(0)},${outbox.giveawayAuditId ?? ''})
          ORDER BY created_at,id LIMIT ${PAGE_SIZE}`;
        for (const row of audit) {
          if (row.messageId) await this.protect(tx, chatId, row.messageId, false);
          if (row.botId) await this.protectBot(tx, chatId, row.botId);
        }
        await tx.$executeRaw`
          UPDATE eraser_protection_outbox SET giveaway_audit_at=${audit.at(-1)?.createdAt ?? outbox.giveawayAuditAt},
            giveaway_audit_id=${audit.at(-1)?.id ?? outbox.giveawayAuditId}, giveaway_audit_complete=${audit.length < PAGE_SIZE},
            giveaway_audit_count=giveaway_audit_count+${audit.length}
          WHERE chat_id=${chatId} AND lease_token=${token}`;
      }
      if (!outbox.holdsComplete) {
        // FLAG: Page candidates before effect probes; never scan a chat's complete deletion history.
        const intents = await tx.$queryRaw<{ id: string; messageId: string; held: boolean }[]>`
          SELECT page.id, page.message_id AS "messageId", (page.status = 'IN_PROGRESS' OR (page.delete_dispatch_started_at IS NOT NULL AND page.remote_delete_succeeded_at IS NULL AND page.status <> 'SUCCEEDED')) AS held
          FROM (SELECT id, message_id, status, delete_dispatch_started_at, remote_delete_succeeded_at FROM moderation_delete_intents WHERE chat_id = ${chatId} AND retention_owned = TRUE AND id > ${outbox.holdCursor ?? ''} ORDER BY id LIMIT ${PAGE_SIZE}) page`;
        for (const intent of intents)
          if (intent.held) await this.protect(tx, chatId, intent.messageId, true);
        await tx.$executeRaw`UPDATE eraser_protection_outbox SET hold_cursor = ${intents.at(-1)?.id ?? outbox.holdCursor}, holds_complete = ${intents.length < PAGE_SIZE} WHERE chat_id = ${chatId} AND lease_token = ${token}`;
      }
      if (outbox.sourceStage < 3) await this.bootstrapSourceHolds(tx, outbox, token);
      await tx.$executeRaw`UPDATE eraser_protection_outbox SET revision = revision + 1, next_attempt_at = CURRENT_TIMESTAMP WHERE chat_id = ${chatId} AND lease_token = ${token}`;
    });
  }

  private async bootstrapSourceHolds(
    tx: Prisma.TransactionClient,
    outbox: OutboxRow,
    token: string,
  ): Promise<void> {
    let cursor: string | null = null;
    let complete = false;
    const table = [
      'webhook_legacy_recoveries',
      'webhook_source_abandonments',
      'webhook_backlog_receipts',
    ][outbox.sourceStage]!;
    // FLAG: This identifier is selected exclusively from the fixed source-table allowlist.
    const rows = await tx.$queryRaw<{ messageId: string }[]>(Prisma.sql`
        SELECT message_id AS "messageId" FROM ${Prisma.raw(table)}
        WHERE chat_id = ${outbox.chatId} AND message_id > ${outbox.sourceCursor ?? ''} ORDER BY message_id LIMIT ${PAGE_SIZE}`);
    for (const row of rows) await this.protect(tx, outbox.chatId, row.messageId, true);
    cursor = rows.at(-1)?.messageId ?? outbox.sourceCursor;
    complete = rows.length < PAGE_SIZE;
    await tx.$executeRaw`UPDATE eraser_protection_outbox SET source_cursor = ${complete ? null : cursor}, source_stage = ${complete ? outbox.sourceStage + 1 : outbox.sourceStage} WHERE chat_id = ${outbox.chatId} AND lease_token = ${token}`;
  }

  private async protect(
    tx: Prisma.TransactionClient,
    chatId: string,
    messageId: string,
    held: boolean,
  ): Promise<void> {
    await tx.$executeRaw`INSERT INTO eraser_protected_messages(chat_id, message_id, held) VALUES(${chatId}, ${messageId}, ${held}) ON CONFLICT(chat_id, message_id) DO UPDATE SET held = eraser_protected_messages.held OR EXCLUDED.held, delivered = CASE WHEN EXCLUDED.held AND NOT eraser_protected_messages.held THEN FALSE ELSE eraser_protected_messages.delivered END`;
  }

  private async protectBot(
    tx: Prisma.TransactionClient,
    chatId: string,
    botId: string,
  ): Promise<void> {
    await tx.$executeRaw`INSERT INTO eraser_protected_bots(chat_id, bot_id) VALUES(${chatId}, ${botId}) ON CONFLICT DO NOTHING`;
  }

  private async fence(
    tx: Prisma.TransactionClient,
    chatId: string,
    sourceKey: string,
    startedAt: Date,
  ): Promise<void> {
    await tx.$executeRaw`INSERT INTO eraser_publication_fences(chat_id, source_key, started_at) VALUES(${chatId}, ${sourceKey}, ${startedAt}) ON CONFLICT(chat_id, source_key) DO UPDATE SET started_at = EXCLUDED.started_at`;
  }

  async syncGlobalHolds(): Promise<void> {
    const token = randomUUID();
    const [state] = await this.prisma.$queryRaw<
      { sourceCursor: string | null; bootstrapComplete: boolean }[]
    >`
      UPDATE eraser_global_hold_state SET lease_token = ${token}, lease_until = CURRENT_TIMESTAMP + INTERVAL '30 seconds'
      WHERE id = 1 AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP)
      RETURNING source_cursor AS "sourceCursor", bootstrap_complete AS "bootstrapComplete"`;
    if (!state) return;
    try {
      if (!state.bootstrapComplete) {
        // FLAG: Legacy global immunity is projected once for the fleet, never rescanned per chat.
        const rows = await this.prisma.$queryRaw<{ id: string; authorId: string }[]>`
          SELECT id, user_id AS "authorId" FROM webhook_legacy_recoveries WHERE id > ${state.sourceCursor ?? ''} ORDER BY id LIMIT ${PAGE_SIZE}`;
        await this.prisma.$transaction(async (tx) => {
          const authors = [...new Set(rows.map((row) => row.authorId))];
          if (authors.length)
            await tx.$executeRaw(
              Prisma.sql`INSERT INTO eraser_held_authors(author_id) VALUES ${Prisma.join(authors.map((id) => Prisma.sql`(${id})`))} ON CONFLICT DO NOTHING`,
            );
          await tx.$executeRaw`UPDATE eraser_global_hold_state SET source_cursor = ${rows.at(-1)?.id ?? state.sourceCursor}, bootstrap_complete = ${rows.length < PAGE_SIZE} WHERE id = 1 AND lease_token = ${token}`;
        });
      }
      const authors = await this.prisma.$queryRaw<{ authorId: string }[]>`
        SELECT author_id AS "authorId" FROM eraser_held_authors WHERE delivered = FALSE ORDER BY author_id LIMIT ${PAGE_SIZE}`;
      if (authors.length) {
        await this.request(
          '/holds',
          'PUT',
          { holdAuthorIds: authors.map((row) => row.authorId) },
          'protection',
        );
        await this.prisma.$executeRaw(
          Prisma.sql`UPDATE eraser_held_authors SET delivered = TRUE WHERE author_id IN (${Prisma.join(authors.map((row) => row.authorId))})`,
        );
      }
    } finally {
      await this.prisma
        .$executeRaw`UPDATE eraser_global_hold_state SET lease_token = NULL, lease_until = NULL WHERE id = 1 AND lease_token = ${token}`;
    }
  }
}

function canonicalRequest(value: UpdateMessageRetention & { operationId: string }) {
  return {
    enabled: value.enabled,
    hours: value.hours,
    expectedRevision: value.expectedRevision,
    operationId: value.operationId,
    connectWhenReady: value.connectWhenReady === true,
  };
}
