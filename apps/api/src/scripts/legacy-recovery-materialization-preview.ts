import { createHash } from 'node:crypto';
import {
  Prisma,
  type WebhookEvent,
  type WebhookExecutionClaim,
  type WebhookLegacyReceiptDisposition,
  type WebhookLegacySealedAuthority,
} from '../prisma/prisma-client';
import { buildGroupCommandKey } from '../common/group-command-key';
import { materializeLegacyReceiptDisposition } from '../webhook/webhook-legacy-receipt-disposition';
import { legacySnapshotDigest } from '../webhook/webhook-legacy-source';
import type { LegacyRecoveryCandidate } from '../webhook/webhook-legacy-cold-install';
import type {
  LegacyRecoveryLiveIssue,
  LegacyRecoveryLivePlanProof,
} from './legacy-recovery-live-protocol';
import type { LegacyRecoverySqlSourceAllowance } from './legacy-recovery-sql-source-resolver';

const PAGE_SIZE = 200;
const PREFIX_PAGES = 200;
const MAX_ROWS = 40_000;
const PAYLOAD_BYTES = 256 * 1024;
const ROW_BYTES = PAYLOAD_BYTES + 64 * 1024;
const PREVIEW_CERTIFICATE = 'preview-only-never-persisted';
const READY_BOUNDARY = Symbol('preview-proof-write-boundary');
type Tx = Pick<Prisma.TransactionClient, '$queryRaw'>;
type ObjectRow = Record<string, unknown>;
type PrefixRow = {
  id: string;
  createdAt: Date;
  payloadBytes: number;
  legacyDispositionId: string | null;
  legacyDispositionReceiptId: string | null;
  chatId: string | null;
  messageId: string | null;
  userId: string | null;
  scopeOversize: boolean;
};
type MaterializationPlanFailure = {
  reason: 'shape' | 'relation' | 'index' | 'filter' | 'node' | 'bound';
  table: string;
  expectedIndex: string;
  indexes: string[];
  nodeTypes: string[];
  estimatedScanRows: number[];
};
export type LegacyRecoveryMaterializationPreview = {
  version: 1;
  activationAuthorized: false;
  decision: 'READY' | 'DENY';
  snapshotAt: string;
  proofSha256: string;
  scannedReceipts: number;
  prefixPages: number;
  cost: { pages: number; rows: number; probes: number; bytes: number };
  plans: LegacyRecoveryLivePlanProof[];
  issues: LegacyRecoveryLiveIssue[];
  planFailure?: MaterializationPlanFailure;
};
function row(value: unknown): ObjectRow | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectRow) : null;
}
function hydrate<T>(input: ObjectRow): T {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      key.endsWith('_at') && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value)
        ? new Date(`${value}${/[zZ]|[+-]\d\d:\d\d$/u.test(value) ? '' : 'Z'}`)
        : value,
    ]),
  ) as T;
}
// FLAG: Preview only. The actual classifier reaches an intercepted proof-creation
// boundary in memory; neither its write methods nor its row-lock SQL can reach SQL.
export async function previewLegacyRecoveryMaterialization(
  tx: Tx,
  candidates: readonly LegacyRecoveryCandidate[],
  allowance: LegacyRecoverySqlSourceAllowance,
): Promise<LegacyRecoveryMaterializationPreview> {
  const cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  const plans: LegacyRecoveryLivePlanProof[] = [],
    issues: LegacyRecoveryLiveIssue[] = [];
  const digest = createHash('sha256');
  let scannedReceipts = 0,
    prefixPages = 0,
    snapshotAt = '';
  let planFailure: MaterializationPlanFailure | undefined;
  const deadline = Math.min(allowance.deadlineAtMs, Date.now() + 120_000);
  const evidence = (value: unknown) => digest.update(legacySnapshotDigest(value)).update('\n');
  const check = () => {
    if (
      Date.now() >= deadline ||
      Object.entries(cost).some(([key, value]) => value > allowance[key as keyof typeof cost])
    )
      throw new Error('materialization_preview_budget');
  };
  const query = async <T>(statement: Prisma.Sql, maximum: number): Promise<T[]> => {
    check();
    if (cost.pages + 1 > allowance.pages || cost.probes + 1 > allowance.probes)
      throw new Error('materialization_preview_budget');
    cost.pages++;
    cost.probes++;
    const result = await tx.$queryRaw<T[]>(statement);
    cost.rows += result.length;
    cost.bytes += Buffer.byteLength(JSON.stringify(result));
    check();
    if (result.length > maximum) throw new Error('materialization_preview_reply');
    return result;
  };
  const read = async <T>(
    statement: Prisma.Sql,
    table: string,
    index: string,
    bounds: string[],
    maximum: number,
    batchInputs = 0,
  ): Promise<T[]> => {
    if (batchInputs) {
      cost.probes += batchInputs;
      check();
    }
    const explain = await query<{ 'QUERY PLAN': unknown }>(
      Prisma.sql`EXPLAIN (VERBOSE, FORMAT JSON) ${statement}`,
      1,
    );
    const document = explain[0]?.['QUERY PLAN'];
    const nodes: ObjectRow[] = [];
    const visit = (value: unknown, depth: number) => {
      const current = row(value);
      if (!current || depth > 16 || nodes.length > 32)
        throw new Error('materialization_preview_plan');
      nodes.push(current);
      if (current.Plans !== undefined) {
        if (!Array.isArray(current.Plans)) throw new Error('materialization_preview_plan');
        for (const child of current.Plans) visit(child, depth + 1);
      }
    };
    if (!Array.isArray(document) || document.length !== 1)
      throw new Error('materialization_preview_plan');
    visit(row(document[0])?.Plan, 0);
    const scans = nodes.filter((node) => node['Relation Name'] !== undefined);
    const scan = scans[0];
    const permittedNodes = batchInputs
      ? [
          'Limit',
          'Index Scan',
          'Index Only Scan',
          'Nested Loop',
          'Values Scan',
          'Memoize',
          'Result',
        ]
      : ['Limit', 'Index Scan', 'Index Only Scan'];
    const failure: MaterializationPlanFailure['reason'] | null =
      scans.length !== 1 || !scan
        ? 'shape'
        : scan['Relation Name'] !== table || scan.Schema !== 'public'
          ? 'relation'
          : scan['Index Name'] !== index ||
              !['Index Scan', 'Index Only Scan'].includes(String(scan['Node Type']))
            ? 'index'
            : scan.Filter !== undefined
              ? 'filter'
              : nodes.some(
                    (node) =>
                      !permittedNodes.includes(String(node['Node Type'])) ||
                      (node['Node Type'] === 'Values Scan' &&
                        Number(node['Plan Rows']) > batchInputs),
                  )
                ? 'node'
                : bounds.some((bound) => !String(scan['Index Cond']).includes(bound))
                  ? 'bound'
                  : null;
    if (failure) {
      // FLAG: Expose only fixed query identity and plan structure, never predicates,
      // SQL, values, payloads, or source identifiers from a refused production plan.
      planFailure = {
        reason: failure,
        table,
        expectedIndex: index,
        indexes: nodes
          .map((node) => String(node['Index Name'] ?? ''))
          .filter((name) => /^[a-z][a-z0-9_]{0,127}$/u.test(name)),
        nodeTypes: nodes
          .map((node) => String(node['Node Type'] ?? ''))
          .filter((name) => /^[A-Za-z ]{1,48}$/u.test(name)),
        estimatedScanRows: scans.map((node) => Number(node['Plan Rows'] ?? 0)),
      };
      throw new Error('materialization_preview_plan');
    }
    const result = await query<T>(statement, maximum);
    plans.push({
      descriptor: `sql:materialization-preview:${table}`,
      querySha256: legacySnapshotDigest({ sql: statement.sql, values: statement.values }),
      planSha256: legacySnapshotDigest(document),
      indexes: [index],
      returnedRows: result.length,
      examinedRows: Number(scan['Plan Rows'] ?? 0),
      probes: 2 + batchInputs,
    });
    return result;
  };
  const literal = (value: string) => `'${value.replace(/'/gu, "''")}'::text`;
  const eq = (column: string, value: string) => `${column} = ${literal(value)}`;
  const fullRow = async <T>(
    table: string,
    index: string,
    where: Prisma.Sql,
    bounds: string[],
    maximum = 1,
  ): Promise<T[]> => {
    const values = await read<{ value: ObjectRow | null; oversize: boolean }>(
      Prisma.sql`
      SELECT CASE WHEN octet_length(to_jsonb(t)::text) <= ${ROW_BYTES} THEN to_jsonb(t) ELSE NULL END AS value,
        octet_length(to_jsonb(t)::text) > ${ROW_BYTES} AS oversize FROM ${Prisma.raw(table)} t WHERE ${where} LIMIT ${maximum}`,
      table,
      index,
      bounds,
      maximum,
    );
    if (values.some((value) => value.oversize || !value.value))
      throw new Error('materialization_preview_oversize');
    return values.map((value) => hydrate<T>(value.value!));
  };
  // FLAG: One bounded VALUES input drives exact indexed probes. LATERAL LIMIT
  // prevents the planner from replacing per-key lookups with a retained-history scan.
  // Charge every input probe, including absent claims, to the original total budget.
  const batchFullRow = async <T>(
    table: string,
    index: string,
    columns: readonly string[],
    keys: readonly string[][],
    perKey = 1,
  ): Promise<T[]> => {
    if (!keys.length) return [];
    if (
      keys.length > PAGE_SIZE * 33 ||
      columns.length < 1 ||
      columns.length > 2 ||
      keys.some((key) => key.length !== columns.length)
    )
      throw new Error('materialization_preview_input');
    const aliases = columns.map((_, i) => `key${i}`);
    const values = await read<{ value: ObjectRow | null; oversize: boolean }>(
      Prisma.sql`SELECT found.value, found.oversize
        FROM (VALUES ${Prisma.join(keys.map((key) => Prisma.sql`(${Prisma.join(key)})`))})
          AS wanted(${Prisma.raw(aliases.join(', '))})
        CROSS JOIN LATERAL (
          SELECT CASE WHEN octet_length(to_jsonb(t)::text) <= ${ROW_BYTES} THEN to_jsonb(t) ELSE NULL END AS value,
            octet_length(to_jsonb(t)::text) > ${ROW_BYTES} AS oversize
          FROM ${Prisma.raw(table)} t
          WHERE ${Prisma.join(
            columns.map(
              (column, i) =>
                Prisma.sql`${Prisma.raw(`t.${column}`)} = ${Prisma.raw(`wanted.${aliases[i]}`)}`,
            ),
            ' AND ',
          )}
          LIMIT ${perKey}
        ) found LIMIT ${keys.length * perKey}`,
      table,
      index,
      [...columns],
      keys.length * perKey,
      keys.length,
    );
    if (values.some((value) => value.oversize || !value.value))
      throw new Error('materialization_preview_oversize');
    return values.map((value) => hydrate<T>(value.value!));
  };
  let kinds: string[] | null = null;
  const claimKinds = async () => {
    if (kinds) return kinds;
    kinds = [];
    let after: string | null = null;
    for (;;) {
      const types: Array<{ kind: string; oversize: boolean }> = await read(
        Prisma.sql`
        SELECT left(kind, 512) AS kind, octet_length(kind) > 512 AS oversize FROM webhook_execution_claims
        ${after === null ? Prisma.empty : Prisma.sql`WHERE kind > ${after}`} ORDER BY webhook_execution_claims.kind LIMIT 1`,
        'webhook_execution_claims',
        'webhook_execution_claims_kind_semantic_key',
        after === null ? [] : [`kind > ${literal(after)}`],
        1,
      );
      if (!types.length) return kinds;
      if (
        types[0]!.oversize ||
        typeof types[0]!.kind !== 'string' ||
        kinds.length === 32 ||
        types[0]!.kind === after
      )
        throw new Error('materialization_preview_claim_kinds');
      after = types[0]!.kind;
      kinds.push(after);
    }
  };
  const settings = new Map<string, ObjectRow | null>();
  try {
    if (
      !candidates.length ||
      candidates.length > 200 ||
      new Set(candidates.map((candidate) => candidate.owner.id)).size !== candidates.length ||
      Object.values(allowance).some((value) => !Number.isSafeInteger(value) || value <= 0)
    )
      throw new Error('materialization_preview_input');
    const session = await query<{
      now: Date;
      readonly: string;
      isolation: string;
      timezone: string;
      timeout: string;
    }>(
      Prisma.sql`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now, current_setting('transaction_read_only') AS readonly,
        current_setting('transaction_isolation') AS isolation, current_setting('TimeZone') AS timezone,
        current_setting('statement_timeout') AS timeout`,
      1,
    );
    const current = session[0];
    const timeout = current?.timeout.match(/^(\d+)(ms|s)?$/u);
    if (
      !current ||
      !(current.now instanceof Date) ||
      current.readonly !== 'on' ||
      current.isolation !== 'repeatable read' ||
      current.timezone !== 'UTC' ||
      !timeout ||
      Number(timeout[1]) * (timeout[2] === 's' ? 1000 : 1) < 1 ||
      Number(timeout[1]) * (timeout[2] === 's' ? 1000 : 1) > 5000
    )
      throw new Error('materialization_preview_snapshot');
    // FLAG: Planner hints affect only this read-only transaction. They are not proof:
    // every query still must pass the exact index, predicate and bounded-shape checks.
    const planner = await query<{ seq: string; bitmap: string; parallel: string }>(
      Prisma.sql`SELECT set_config('enable_seqscan', 'off', true) AS seq,
        set_config('enable_bitmapscan', 'off', true) AS bitmap,
        set_config('max_parallel_workers_per_gather', '0', true) AS parallel`,
      1,
    );
    if (
      planner.length !== 1 ||
      planner[0]!.seq !== 'off' ||
      planner[0]!.bitmap !== 'off' ||
      planner[0]!.parallel !== '0'
    )
      throw new Error('materialization_preview_planner');
    snapshotAt = current.now.toISOString();
    const scopes = [...candidates]
      .sort((a, b) => a.owner.id.localeCompare(b.owner.id))
      .map((candidate) => {
        const ownerSnapshot = Object.fromEntries(
          Object.entries(candidate.owner).filter(
            ([key]) => !['rawPayload', 'normalizedPayload'].includes(key),
          ),
        );
        return {
          id: candidate.owner.id,
          certificateId: PREVIEW_CERTIFICATE,
          authorityVersion: 1,
          disposition: 'NO_REPLAY_ORDER_RELEASED',
          ownerWebhookEventId: candidate.owner.id,
          claimId: candidate.claim.id,
          ownerSnapshot,
          claimSnapshot: candidate.claim,
          rawPayloadDigest: candidate.rawPayloadDigest,
          normalizedPayloadDigest: candidate.normalizedPayloadDigest,
          ...candidate.source,
        };
      });
    evidence(scopes);
    const authority = {
      id: PREVIEW_CERTIFICATE,
      certificateId: PREVIEW_CERTIFICATE,
      authorityVersion: 1,
      sealedAt: current.now,
    };
    for (const chatId of [...new Set(scopes.map((scope) => scope.chatId))].sort()) {
      let cursor: { id: string; createdAt: Date } | null = null;
      for (;;) {
        if (++prefixPages > PREFIX_PAGES) throw new Error('materialization_preview_saturated');
        const page: PrefixRow[] = await read(
          Prisma.sql`
          SELECT id, created_at AS "createdAt", legacy_disposition_id AS "legacyDispositionId",
            legacy_disposition_receipt_id AS "legacyDispositionReceiptId",
            octet_length(raw_payload::text) + octet_length(normalized_payload::text) AS "payloadBytes",
            CASE WHEN jsonb_typeof(normalized_payload->'message'->'chatId') = 'string' THEN left(normalized_payload->'message'->>'chatId', 512) END AS "chatId",
            CASE WHEN jsonb_typeof(normalized_payload->'message'->'messageId') = 'string' THEN left(normalized_payload->'message'->>'messageId', 512) END AS "messageId",
            CASE WHEN jsonb_typeof(normalized_payload->'message'->'senderId') = 'string' THEN left(normalized_payload->'message'->>'senderId', 512) END AS "userId",
            COALESCE(octet_length(normalized_payload->'message'->>'chatId') > 512 OR octet_length(normalized_payload->'message'->>'messageId') > 512 OR octet_length(normalized_payload->'message'->>'senderId') > 512, false) AS "scopeOversize"
          FROM webhook_events WHERE COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''), NULLIF(BTRIM(normalized_payload->>'chatId'), '')) = ${chatId}
            AND (status = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[]) OR (status = 'FAILED'::"WebhookStatus" AND (next_enqueue_at IS NOT NULL OR LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')))
            AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''), NULLIF(BTRIM(normalized_payload->>'update_type'), ''))) = ANY(ARRAY['message_created','message_edited'])
            ${cursor ? Prisma.sql`AND (created_at, id) > (${cursor.createdAt}, ${cursor.id})` : Prisma.empty}
          ORDER BY created_at, id LIMIT ${PAGE_SIZE + 1}`,
          'webhook_events',
          'webhook_events_ordered_chat_head_idx',
          [literal(chatId)],
          PAGE_SIZE + 1,
        );
        const sourceMetas = page
          .slice(0, PAGE_SIZE)
          .filter(
            (meta) =>
              meta.legacyDispositionId ||
              meta.legacyDispositionReceiptId ||
              scopes.some(
                (scope) =>
                  meta.chatId !== null &&
                  ((scope.chatId === meta.chatId && scope.messageId === (meta.messageId ?? '')) ||
                    scope.userId === (meta.userId ?? '')),
              ),
          );
        if (
          sourceMetas.some(
            (meta) =>
              !Number.isSafeInteger(meta.payloadBytes) ||
              meta.payloadBytes > PAYLOAD_BYTES ||
              meta.scopeOversize,
          )
        )
          throw new Error('materialization_preview_receipt');
        if (
          sourceMetas.reduce((sum, meta) => sum + meta.payloadBytes, 0) >
          allowance.bytes - cost.bytes
        )
          throw new Error('materialization_preview_budget');
        const sourceEvents = await batchFullRow<WebhookEvent>(
          'webhook_events',
          'webhook_events_pkey',
          ['id'],
          sourceMetas.map(({ id }) => [id]),
        );
        const eventsById = new Map(sourceEvents.map((event) => [event.id, event]));
        if (
          eventsById.size !== sourceMetas.length ||
          sourceMetas.some((meta) => !eventsById.has(meta.id))
        )
          throw new Error('materialization_preview_receipt');
        // FLAG: Existing pointers require the same positive proof classifier as the
        // writer, including prior certificates. Exact batched PK probes retain the
        // original page/byte budget; pointers alone never skip receipt validation.
        const proofs = await batchFullRow<WebhookLegacyReceiptDisposition>(
          'webhook_legacy_receipt_dispositions',
          'webhook_legacy_receipt_dispositions_pkey',
          ['id'],
          [
            ...new Set(
              sourceMetas
                .map((meta) => meta.legacyDispositionId)
                .filter((id): id is string => id !== null),
            ),
          ].map((id) => [id]),
        );
        const priorAuthorities = await batchFullRow<WebhookLegacySealedAuthority>(
          'webhook_legacy_sealed_authorities',
          'webhook_legacy_sealed_authorities_pkey',
          ['id'],
          [...new Set(proofs.map((proof) => proof.authorityId))].map((id) => [id]),
        );
        const authoritiesById = new Map(priorAuthorities.map((value) => [value.id, value]));
        const proofsById = new Map(
          proofs.map((proof) => [
            proof.id,
            {
              ...proof,
              authority: authoritiesById.get(proof.authorityId) ?? null,
            },
          ]),
        );
        const heldEvents = sourceEvents.filter(
          (event) => !event.legacyDispositionId && !event.legacyDispositionReceiptId,
        );
        const linkedClaims = await batchFullRow<WebhookExecutionClaim>(
          'webhook_execution_claims',
          'webhook_execution_claims_event_kind_idx',
          ['webhook_event_id'],
          heldEvents.map(({ id }) => [id]),
          33,
        );
        if (
          heldEvents.some(
            ({ id }) => linkedClaims.filter((claim) => claim.webhookEventId === id).length > 32,
          )
        )
          throw new Error('materialization_preview_claims');
        const semanticPairs = new Map<string, string[]>();
        const allKinds = heldEvents.length ? await claimKinds() : [];
        for (const event of heldEvents) {
          const message = row(row(event.normalizedPayload)?.message);
          const commandKey =
            typeof message?.messageId === 'string'
              ? buildGroupCommandKey(String(message.chatId), message.messageId)
              : '';
          for (const pair of [
            ['COMMAND', commandKey],
            ...(event.semanticKey ? allKinds.map((kind) => [kind, event.semanticKey!]) : []),
          ])
            semanticPairs.set(JSON.stringify(pair), pair);
        }
        const semanticClaims = await batchFullRow<WebhookExecutionClaim>(
          'webhook_execution_claims',
          'webhook_execution_claims_kind_semantic_key',
          ['kind', 'semantic_key'],
          [...semanticPairs.values()],
        );
        const pageClaims = [
          ...new Map(
            [...linkedClaims, ...semanticClaims].map((claim) => [claim.id, claim]),
          ).values(),
        ];
        for (const meta of page.slice(0, PAGE_SIZE)) {
          if (++scannedReceipts > MAX_ROWS) throw new Error('materialization_preview_saturated');
          if (
            !(meta.createdAt instanceof Date) ||
            meta.createdAt > current.now ||
            !Number.isSafeInteger(meta.payloadBytes) ||
            meta.scopeOversize
          )
            throw new Error('materialization_preview_receipt');
          const matches = scopes
            .filter(
              (scope) =>
                meta.chatId !== null &&
                ((scope.chatId === meta.chatId && scope.messageId === (meta.messageId ?? '')) ||
                  scope.userId === (meta.userId ?? '')),
            )
            .sort(
              (a, b) =>
                Number(b.ownerWebhookEventId === meta.id) -
                  Number(a.ownerWebhookEventId === meta.id) || a.id.localeCompare(b.id),
            );
          if (!matches.length && !meta.legacyDispositionId && !meta.legacyDispositionReceiptId) {
            evidence({ meta, result: 'NOT_HELD' });
            continue;
          }
          const event = eventsById.get(meta.id);
          if (!event) throw new Error('materialization_preview_receipt');
          const scope = matches[0];
          let claims: WebhookExecutionClaim[] | null = null;
          const readClaims = async () => {
            if (claims) return claims;
            const message = row(row(event.normalizedPayload)?.message);
            const commandKey =
              typeof message?.messageId === 'string'
                ? buildGroupCommandKey(String(message.chatId), message.messageId)
                : '';
            claims = pageClaims
              .filter(
                (claim) =>
                  claim.webhookEventId === event.id ||
                  (claim.kind === 'COMMAND' && claim.semanticKey === commandKey) ||
                  (event.semanticKey && claim.semanticKey === event.semanticKey),
              )
              .sort((a, b) => a.id.localeCompare(b.id));
            evidence(claims);
            return claims;
          };
          const readSettings = async () => {
            if (!settings.has(meta.chatId!)) {
              const value =
                (
                  await fullRow<ObjectRow>(
                    'chat_settings',
                    'chat_settings_chat_id_key',
                    Prisma.sql`t.chat_id = ${meta.chatId}`,
                    [eq('chat_id', meta.chatId!)],
                  )
                )[0] ?? null;
              settings.set(meta.chatId!, value);
              evidence({ chatId: meta.chatId, settings: value });
            }
            return settings.get(meta.chatId!);
          };
          const facade = {
            $queryRaw: async (sql: Prisma.Sql) => {
              if (sql.sql.includes('FROM "webhook_events"') && sql.sql.includes('FOR UPDATE'))
                return [meta];
              if (sql.sql.includes('FROM "webhook_legacy_recoveries"'))
                return scope ? [{ recoveryId: scope.id, authorityId: authority.id }] : [];
              if (
                sql.sql.includes('FROM "webhook_execution_claims"') &&
                sql.sql.includes('FOR UPDATE')
              )
                return (await readClaims()).map(({ id }) => ({ id }));
              throw new Error('materialization_preview_classifier_sql');
            },
            webhookEvent: { findUnique: async () => event },
            webhookLegacyReceiptDisposition: {
              findUnique: async (args: { where: { id: string } }) => {
                const proof = proofsById.get(args.where.id) ?? null;
                evidence({ proof });
                return proof;
              },
              create: async () => {
                throw READY_BOUNDARY;
              },
            },
            webhookLegacySealedAuthority: { findUnique: async () => authority },
            webhookLegacyRecovery: { findUnique: async () => scope },
            webhookExecutionClaim: {
              findMany: async (args: { where: { webhookEventId: string }; take: number }) =>
                (await readClaims())
                  .filter((claim) => claim.webhookEventId === args.where.webhookEventId)
                  .slice(0, args.take),
              findUnique: async (args: {
                where: { kind_semanticKey: { kind: string; semanticKey: string } };
              }) =>
                (await readClaims()).find(
                  (claim) =>
                    claim.kind === args.where.kind_semanticKey.kind &&
                    claim.semanticKey === args.where.kind_semanticKey.semanticKey,
                ) ?? null,
              findFirst: async (args: { where: { kind?: { gt: string } } }) => {
                const next = (await claimKinds()).find(
                  (kind) => !args.where.kind || kind > args.where.kind.gt,
                );
                return next === undefined ? null : { kind: next };
              },
            },
            chatSettings: { findUnique: readSettings },
          } as unknown as Prisma.TransactionClient;
          let outcome: string;
          try {
            outcome = await materializeLegacyReceiptDisposition(facade, event.id, {
              preSeal: true,
              certificateId: PREVIEW_CERTIFICATE,
            });
          } catch (error) {
            if (error !== READY_BOUNDARY) throw error;
            outcome = 'WOULD_MATERIALIZE';
          }
          if (!['WOULD_MATERIALIZE', 'NOT_HELD', 'ALREADY_APPLIED_SAME_PROOF'].includes(outcome))
            throw new Error('materialization_preview_blocked');
          evidence({ event, outcome });
        }
        if (page.length <= PAGE_SIZE) break;
        cursor = page[PAGE_SIZE - 1]!;
      }
    }
    check();
  } catch (error) {
    issues.push({
      code:
        error instanceof Error && /^materialization_preview_[a-z_]+$/u.test(error.message)
          ? error.message
          : 'materialization_preview_unproved',
      descriptor: 'sql:materialization-preview',
    });
  }
  return {
    version: 1,
    activationAuthorized: false,
    decision: issues.length ? 'DENY' : 'READY',
    snapshotAt,
    proofSha256: digest.digest('hex'),
    scannedReceipts,
    prefixPages,
    cost,
    plans,
    issues,
    ...(planFailure ? { planFailure } : {}),
  };
}
