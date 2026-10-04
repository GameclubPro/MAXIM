import { parseArgs } from 'node:util';
import { open, unlink } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import {
  ANTIDUPLICATE_CORPUS_VERSION,
  antiduplicateCorpusManifestSchema,
  antiduplicateCorpusEventSchema,
  assertLocalReplayUrl,
  assertPrivateCorpusPath,
  chooseStratifiedChats,
  corpusDigest,
  normalizeCorpusSettings,
  corpusTimestamp,
  type CorpusRejectionCause,
} from './antiduplicate-corpus';
import { WebhookParser } from '../webhook/webhook.parser';
import { duplicatePublicationTime } from '../moderation/message-duplicate/message-duplicate-publication-time';
import { selectMaxMessageCandidate } from '../max/max-message-candidate.util';

type SourceRow = {
  id: string;
  normalized: Record<string, unknown>;
  raw: Record<string, unknown>;
  createdAt: Date;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function settingsFromSql(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, x]) => [
      key.replace(/_([a-z])/gu, (_, char: string) => char.toUpperCase()),
      x,
    ]),
  );
}

export function pseudonymizeCorpusRaw(
  raw: Record<string, unknown>,
  salt: string,
): Record<string, unknown> {
  const type = String(raw.type ?? raw.update_type ?? raw.event_type ?? 'unknown');
  const selected = selectMaxMessageCandidate(raw, type)?.node;
  const messageContainers = new Set(
    [selected, selected?.body, selected?.content, selected?.data].filter(
      (node) => node && typeof node === 'object' && !Array.isArray(node),
    ),
  );
  const visit = (value: unknown, key = '', parentKey = '', parentNode?: object): unknown => {
    if (Array.isArray(value)) return value.map((x) => visit(x, key, parentKey, parentNode));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([k]) =>
              !['name', 'first_name', 'last_name', 'username', 'photo_url', 'avatar_url'].includes(
                k,
              ),
          )
          .map(([k, x]) => [k, visit(x, k, key, value)]),
      );
    }
    if (value === null || value === undefined) return value;
    if (
      [
        'chat_id',
        'chatId',
        'user_id',
        'userId',
        'sender_id',
        'senderId',
        'dialog_id',
        'dialogId',
      ].includes(key) ||
      (key === 'id' &&
        ['sender', 'from', 'actor', 'user', 'recipient', 'chat', 'conversation', 'dialog'].includes(
          parentKey,
        ))
    )
      return `${String(value).startsWith('-') ? '-' : ''}${BigInt(`0x${corpusDigest([salt, 'entity', String(value)]).slice(0, 15)}`).toString()}`;
    // FLAG: seq/id are message identity only in the parser-selected canonical containers.
    // Arbitrary attachment/navigation/callback IDs are product content, never entity aliases.
    if (
      (messageContainers.has(parentNode) &&
        ['mid', 'message_id', 'messageId', 'seq', 'id'].includes(key)) ||
      (parentNode === raw && ['mid', 'message_id', 'messageId', 'seq'].includes(key))
    )
      return corpusDigest([salt, 'message', String(value)]);
    return value;
  };
  // FLAG: Prose/navigation stay faithful in this private corpus. Redacting phone/URL values
  // would hide the very comparison errors being evaluated; never publish these records.
  return visit(raw) as Record<string, unknown>;
}

export function inspectCorpusSourceRow(
  row: SourceRow,
  salt: string,
): {
  event: ReturnType<typeof antiduplicateCorpusEventSchema.parse> | null;
  rejection: CorpusRejectionCause | null;
} {
  const reject = (rejection: CorpusRejectionCause) => ({ event: null, rejection });
  const normalized = record(row.normalized.message);
  const identity = (value: unknown) =>
    typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
      ? String(value).trim()
      : '';
  const chatId = identity(normalized.chatId);
  const messageId = identity(normalized.messageId);
  const senderId = identity(normalized.senderId);
  const type = row.normalized.type;
  if (!chatId || !messageId || (type !== 'message_removed' && !senderId))
    return reject('MISSING_NORMALIZED_IDENTITY');
  if (row.normalized.eventTimestampSource === 'ingress') return reject('UNTRUSTED_SOURCE_TIME');
  if (Object.keys(record(row.raw)).length === 0) return reject('RAW_SOURCE_MISSING');
  const parser = new WebhookParser();
  let source;
  try {
    source = parser.parse(row.raw);
  } catch {
    return reject('SOURCE_PARSE_FAILED');
  }
  if (source.eventTimestampSource !== 'payload') return reject('UNTRUSTED_SOURCE_TIME');
  if (
    source.type !== type ||
    !source.message ||
    source.message.chatId !== chatId ||
    source.message.messageId !== messageId ||
    (type !== 'message_removed' && source.message.senderId !== senderId)
  )
    return reject('SOURCE_IDENTITY_MISMATCH');
  const raw = pseudonymizeCorpusRaw(row.raw, salt);
  let parsed;
  try {
    parsed = parser.parse(raw);
  } catch {
    return reject('PSEUDONYM_PARSE_FAILED');
  }
  const entityId = (value: string) => String(pseudonymizeCorpusRaw({ chatId: value }, salt).chatId);
  if (
    parsed.type !== type ||
    parsed.eventTimestampSource !== 'payload' ||
    !parsed.message ||
    parsed.message.chatId !== entityId(chatId) ||
    parsed.message.messageId !== corpusDigest([salt, 'message', messageId]) ||
    (type !== 'message_removed' && parsed.message.senderId !== entityId(senderId))
  )
    return reject('PSEUDONYM_IDENTITY_MISMATCH');
  const publishedAtMs = duplicatePublicationTime(parsed);
  const result = antiduplicateCorpusEventSchema.safeParse({
    type: 'EVENT',
    id: corpusDigest([salt, row.id]),
    chatId: entityId(chatId),
    userId: senderId ? entityId(senderId) : null,
    messageId: corpusDigest([salt, 'message', messageId]),
    eventType: type,
    eventAt: parsed.message.createdAt,
    receivedAt: corpusTimestamp(row.createdAt),
    publishedAt: publishedAtMs ? new Date(publishedAtMs).toISOString() : null,
    raw,
    historicalAction: 'UNKNOWN',
  });
  return result.success ? { event: result.data, rejection: null } : reject('INVALID_CORPUS_EVENT');
}
export function corpusEventFromSourceRow(row: SourceRow, salt: string) {
  return inspectCorpusSourceRow(row, salt).event;
}

export async function exportAntiduplicateCorpus(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      output: { type: 'string' },
      'snapshot-sha256': { type: 'string' },
      'snapshot-at': { type: 'string' },
      'minimum-chats': { type: 'string', default: '20' },
      'max-events': { type: 'string', default: '500000' },
    },
    strict: true,
  });
  if (
    !values.output ||
    !/^[a-f0-9]{64}$/u.test(values['snapshot-sha256'] ?? '') ||
    !corpusTimestamp(values['snapshot-at'])
  )
    throw new Error(
      'Usage: --output <private.jsonl> --snapshot-sha256 <sha> --snapshot-at <UTC-ISO> [--minimum-chats 20] [--max-events 500000]',
    );
  const minimum = Number(values['minimum-chats']);
  const cap = Number(values['max-events']);
  if (
    !Number.isInteger(minimum) ||
    minimum < 20 ||
    minimum > 1000 ||
    !Number.isInteger(cap) ||
    cap < 1 ||
    cap > 2_000_000
  )
    throw new Error('Invalid bounded corpus cohort or event budget');
  const databaseUrl =
    process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL ?? process.env.MAXIM_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error('An isolated restored snapshot URL is required');
  assertLocalReplayUrl(databaseUrl, 'postgres');
  const output = await assertPrivateCorpusPath(values.output, false);
  const end = new Date(values['snapshot-at']!);
  end.setUTCHours(0, 0, 0, 0);
  const from = new Date(end.getTime() - 7 * 86_400_000);
  const warmup = new Date(from.getTime() - 7 * 86_400_000);
  const holdout = new Date(end.getTime() - 2 * 86_400_000);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'maxim_antiduplicate_offline_export',
    options:
      '-c timezone=UTC -c default_transaction_read_only=on -c max_parallel_workers_per_gather=0 -c statement_timeout=300000',
  });
  let client: PoolClient | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let created = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const settingsRows = await client.query<{ chatId: string; settings: Record<string, unknown> }>(
      'SELECT chat_id AS "chatId", row_to_json(s) AS settings FROM chat_settings s ORDER BY chat_id LIMIT 50001',
    );
    if (settingsRows.rows.length > 50_000)
      throw new Error('Settings snapshot exceeds the export budget');
    const activity = await client.query<{ chatId: string; events: string }>(
      `
      SELECT normalized_payload->'message'->>'chatId' AS "chatId", count(*)::text AS events
      FROM webhook_events WHERE created_at >= $1 AND created_at < $2
        AND normalized_payload->>'type' IN ('message_created', 'message_edited', 'message_removed')
      GROUP BY normalized_payload->'message'->>'chatId'`,
      [from, end],
    );
    const counts = new Map(activity.rows.map((x) => [x.chatId, Number(x.events)]));
    const eligible = settingsRows.rows.flatMap((x) => {
      const settings = normalizeCorpusSettings(settingsFromSql(x.settings));
      const events = counts.get(x.chatId) ?? 0;
      return settings.antiDuplicateEnabled && events > 0
        ? [
            {
              chatId: x.chatId,
              events,
              settings,
              stratum: [
                settings.duplicateDetectionPreset,
                settings.duplicateCompareMode,
                settings.duplicatePhotoScope,
                settings.duplicateWindowMode,
              ].join(':'),
            },
          ]
        : [];
    });
    const cohort = chooseStratifiedChats(eligible, minimum);
    const salt = values['snapshot-sha256']!;
    const entityId = (id: string) => String(pseudonymizeCorpusRaw({ chatId: id }, salt).chatId);
    const settings = Object.fromEntries(
      cohort.map((x) => [entityId(x.chatId), x.settings as unknown as Record<string, unknown>]),
    );
    const manifest = antiduplicateCorpusManifestSchema.parse({
      type: 'MANIFEST',
      version: ANTIDUPLICATE_CORPUS_VERSION,
      sourceSnapshotSha256: salt,
      sourceSnapshotAt: values['snapshot-at'],
      from: from.toISOString(),
      until: end.toISOString(),
      holdoutFrom: holdout.toISOString(),
      warmupFrom: warmup.toISOString(),
      settingsBasis: 'SNAPSHOT_REPLAY',
      cohortComplete: cohort.length >= minimum,
      sourceComplete: false,
      selectedChats: cohort.length,
      eligibleChats: eligible.length,
      settings,
    });
    file = await open(output, 'wx', 0o600);
    created = true;
    // Source completeness is established by the EOF sentinel, not by writing a hopeful header.
    await file.write(`${JSON.stringify(manifest)}\n`);
    await client.query(
      `DECLARE antiduplicate_events NO SCROLL CURSOR FOR
      SELECT id, normalized_payload AS normalized, raw_payload AS raw, created_at AS "createdAt"
      FROM webhook_events WHERE created_at >= $1 AND created_at < $2
        AND normalized_payload->'message'->>'chatId' = ANY($3::text[])
        AND normalized_payload->>'type' IN ('message_created', 'message_edited', 'message_removed')
      ORDER BY created_at, id`,
      [warmup, end, cohort.map((x) => x.chatId)],
    );
    let scanned = 0;
    let exported = 0;
    let rejected = 0;
    const rejectionCauses: Partial<Record<CorpusRejectionCause, number>> = {};
    let saturated = false;
    while (true) {
      const batch = await client.query<SourceRow>('FETCH FORWARD 500 FROM antiduplicate_events');
      if (!batch.rows.length) break;
      for (const row of batch.rows) {
        if (++scanned > cap) {
          saturated = true;
          break;
        }
        const inspected = inspectCorpusSourceRow(row, salt);
        const event = inspected.event;
        const cause =
          inspected.rejection ??
          (event &&
          (Date.parse(event.eventAt) < warmup.getTime() ||
            Date.parse(event.eventAt) >= end.getTime())
            ? 'EVENT_OUTSIDE_INTERVAL'
            : null);
        if (cause || !event) {
          ++rejected;
          const classified = cause ?? 'INVALID_CORPUS_EVENT';
          rejectionCauses[classified] = (rejectionCauses[classified] ?? 0) + 1;
          continue;
        }
        await file.write(`${JSON.stringify(event)}\n`);
        ++exported;
      }
      if (saturated) break;
    }
    await file.write(
      `${JSON.stringify({
        type: 'END',
        scanned: Math.min(scanned, cap),
        exported,
        rejected,
        rejectionCauses,
        saturated,
        sourceComplete: !saturated && rejected === 0,
      })}\n`,
    );
    await file.sync();
    await file.close();
    file = undefined;
    await client.query('COMMIT');
    published = true;
    const summary = {
      sourceSnapshotAt: manifest.sourceSnapshotAt,
      evaluationFrom: manifest.from,
      evaluationUntil: manifest.until,
      selectedChats: cohort.length,
      eligibleChats: eligible.length,
      exported,
      rejected,
      rejectionCauses,
      saturated,
      settingsBasis: manifest.settingsBasis,
      historicalActionAccuracy: 'UNKNOWN',
      manualLabels: 'NOT_SUPPLIED',
      sourceComplete: !saturated && rejected === 0,
      snapshotAgeDays: Math.max(
        0,
        Math.floor((Date.now() - Date.parse(manifest.sourceSnapshotAt)) / 86_400_000),
      ),
      warnings:
        Date.now() - Date.parse(manifest.sourceSnapshotAt) > 7 * 86_400_000
          ? ['HISTORICAL_SNAPSHOT_NOT_CURRENT_PRODUCTION']
          : [],
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    if (file) await file.close();
    if (!published) {
      if (created) await unlink(output).catch(() => undefined);
      await client?.query('ROLLBACK').catch(() => undefined);
    }
    client?.release();
    await pool.end();
  }
}
if (require.main === module)
  void exportAntiduplicateCorpus(process.argv.slice(2)).catch(() => {
    process.stderr.write('Antiduplicate export failed; private inputs were not printed.\n');
    process.exitCode = 1;
  });
