import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { chatSettingsSchema } from '@maxim/contracts';
import type { ChatSettings } from '../prisma/prisma-client';

export const ANTIDUPLICATE_CORPUS_VERSION = 'antiduplicate-corpus/v1';
export const ANTIDUPLICATE_CORPUS_REJECTION_CAUSES = [
  'RAW_SOURCE_MISSING',
  'MISSING_NORMALIZED_IDENTITY',
  'UNTRUSTED_SOURCE_TIME',
  'SOURCE_PARSE_FAILED',
  'SOURCE_IDENTITY_MISMATCH',
  'PSEUDONYM_PARSE_FAILED',
  'PSEUDONYM_IDENTITY_MISMATCH',
  'INVALID_CORPUS_EVENT',
  'EVENT_OUTSIDE_INTERVAL',
] as const;
export type CorpusRejectionCause = (typeof ANTIDUPLICATE_CORPUS_REJECTION_CAUSES)[number];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const antiduplicateCorpusManifestSchema = z
  .object({
    type: z.literal('MANIFEST'),
    version: z.literal(ANTIDUPLICATE_CORPUS_VERSION),
    sourceSnapshotSha256: hash,
    sourceSnapshotAt: z.iso.datetime(),
    from: z.iso.datetime(),
    until: z.iso.datetime(),
    holdoutFrom: z.iso.datetime(),
    warmupFrom: z.iso.datetime(),
    settingsBasis: z.enum(['SNAPSHOT_REPLAY', 'HISTORICAL_VERIFIED']),
    cohortComplete: z.boolean(),
    sourceComplete: z.boolean(),
    selectedChats: z.number().int().nonnegative(),
    eligibleChats: z.number().int().nonnegative(),
    settings: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .strict()
  .refine((x) => {
    const start = Date.parse(x.from);
    const end = Date.parse(x.until);
    return (
      [x.from, x.until, x.holdoutFrom, x.warmupFrom].every(
        (time) => time.endsWith('T00:00:00.000Z') || time.endsWith('T00:00:00Z'),
      ) &&
      start - Date.parse(x.warmupFrom) === 7 * 86_400_000 &&
      start < Date.parse(x.holdoutFrom) &&
      Date.parse(x.holdoutFrom) < end &&
      end <= Date.parse(x.sourceSnapshotAt) &&
      end - start === 7 * 86_400_000 &&
      end - Date.parse(x.holdoutFrom) === 2 * 86_400_000 &&
      Object.keys(x.settings).length === x.selectedChats &&
      x.selectedChats <= x.eligibleChats
    );
  }, 'Corpus requires seven complete UTC days and a final two-day temporal holdout');

export const antiduplicateCorpusEventSchema = z
  .object({
    type: z.literal('EVENT'),
    id: hash,
    chatId: z.string().min(1).max(160),
    userId: z.string().min(1).max(160).nullable(),
    messageId: z.string().min(1).max(512),
    eventType: z.enum(['message_created', 'message_edited', 'message_removed']),
    eventAt: z.iso.datetime(),
    receivedAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().nullable(),
    raw: z.record(z.string(), z.unknown()),
    mediaProof: z
      .object({
        sourceDigest: hash,
        algorithmVersion: z.string().min(1).max(160),
        hashes: z.array(hash).min(1).max(10),
      })
      .strict()
      .optional(),
    historicalAction: z.enum(['UNKNOWN', 'NONE', 'DELETE_CONFIRMED', 'ABSENCE_CONFIRMED']),
  })
  .strict()
  .refine(
    (x) => x.eventType === 'message_removed' || x.userId !== null,
    'Created/edited messages require an author',
  );

export const antiduplicateCorpusEndSchema = z
  .object({
    type: z.literal('END'),
    scanned: z.number().int().nonnegative().max(2_000_000),
    exported: z.number().int().nonnegative().max(2_000_000),
    rejected: z.number().int().nonnegative().max(2_000_000),
    rejectionCauses: z
      .partialRecord(
        z.enum(ANTIDUPLICATE_CORPUS_REJECTION_CAUSES),
        z.number().int().nonnegative().max(2_000_000),
      )
      .optional(),
    saturated: z.boolean(),
    sourceComplete: z.boolean(),
  })
  .strict()
  .refine(
    (x) =>
      x.scanned === x.exported + x.rejected &&
      x.sourceComplete === (!x.saturated && x.rejected === 0) &&
      (!x.rejectionCauses ||
        Object.values(x.rejectionCauses).reduce((sum, count) => sum + count, 0) === x.rejected),
  );

export const antiduplicateCorpusLabelSchema = z
  .object({
    id: hash,
    corpusSha256: hash,
    duplicate: z.boolean(),
    actionAllowed: z.boolean(),
    reviewerKind: z.enum(['HUMAN', 'AGENT']),
    reviewer: z.string().min(1).max(160),
    reviewedAt: z.iso.datetime(),
    originalMessageId: z.string().min(1).max(512).optional(),
  })
  .strict();

export type AntiduplicateCorpusManifest = z.infer<typeof antiduplicateCorpusManifestSchema>;
export type AntiduplicateCorpusEvent = z.infer<typeof antiduplicateCorpusEventSchema>;
export type AntiduplicateCorpusLabel = z.infer<typeof antiduplicateCorpusLabelSchema>;

export function corpusDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeCorpusSettings(value: Record<string, unknown>): ChatSettings {
  // FLAG: A snapshot can replay current policy, but cannot prove historical settings or rights.
  // Unrelated historical UI settings must neither block replay nor enter its private corpus.
  const isDuplicateKey = (key: string) =>
    key === 'antiDuplicateEnabled' || /^duplicate[A-Z]/u.test(key);
  const projected = Object.fromEntries(
    Object.entries(value).filter(([key]) => isDuplicateKey(key)),
  );
  const parsed = chatSettingsSchema.parse(projected);
  return {
    ...Object.fromEntries(Object.entries(parsed).filter(([key]) => isDuplicateKey(key))),
    duplicatePolicyRevision: z
      .number()
      .int()
      .nonnegative()
      .parse(value.duplicatePolicyRevision ?? 0),
    duplicateHistoryRevision: z
      .number()
      .int()
      .nonnegative()
      .parse(value.duplicateHistoryRevision ?? 0),
  } as unknown as ChatSettings;
}

export function assertLocalReplayUrl(value: string, protocol: 'postgres' | 'redis'): URL {
  const url = new URL(value);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    (protocol === 'postgres'
      ? !['postgres:', 'postgresql:'].includes(url.protocol)
      : url.protocol !== 'redis:')
  )
    throw new Error('Offline evaluation requires an isolated loopback store');
  if (
    protocol === 'postgres' &&
    !/^\/(?:maxim_(?:race_test|antiduplicate_replay)_[a-z0-9_]+)$/u.test(url.pathname)
  )
    throw new Error('Offline evaluation refuses a non-disposable database');
  return url;
}

export async function assertPrivateCorpusPath(path: string, existing: boolean): Promise<string> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parentStat = await lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o077) !== 0 ||
    (await realpath(parent)) !== parent ||
    parentStat.uid !== process.getuid?.()
  )
    throw new Error('Corpus parent must be a real owner-private directory');
  if (existing) {
    const stat = await lstat(absolute);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      (await realpath(absolute)) !== absolute
    )
      throw new Error('Corpus input must be a private regular file');
  }
  return absolute;
}

export async function assertDistinctCorpusPaths(
  paths: ReadonlyArray<{ path: string; existing: boolean }>,
): Promise<string[]> {
  const validated: string[] = [];
  const identities = new Set<string>();
  for (const input of paths) {
    const path = await assertPrivateCorpusPath(input.path, input.existing);
    if (validated.includes(path))
      throw new Error('Corpus inputs and outputs must use distinct real paths');
    if (input.existing) {
      const stat = await lstat(path);
      const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity)) throw new Error('Corpus inputs must not alias the same file');
      identities.add(identity);
    }
    validated.push(path);
  }
  return validated;
}

export function corpusTimestamp(value: unknown): string | null {
  let time =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Date.parse(value)
          : NaN;
  if (typeof value === 'number' && time < 10_000_000_000) time *= 1000;
  return Number.isSafeInteger(time) && time > 0 && time <= 8_640_000_000_000_000
    ? new Date(time).toISOString()
    : null;
}

export async function* readCorpusLines(path: string): AsyncGenerator<unknown> {
  await assertPrivateCorpusPath(path, true);
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let lineNumber = 0;
  let pending = '';
  const parse = (line: string) => {
    ++lineNumber;
    if (Buffer.byteLength(line, 'utf8') > 2 * 1024 * 1024)
      throw new Error(`Corpus line ${lineNumber} exceeds the input budget`);
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid corpus JSON at line ${lineNumber}`);
    }
  };
  try {
    // FLAG: Only physical LF frames JSONL. Node readline also splits U+2028/U+2029,
    // which JSON.stringify legally preserves inside user text and navigation payloads.
    for await (const chunk of stream) {
      pending += chunk;
      let separator;
      while ((separator = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, separator);
        pending = pending.slice(separator + 1);
        if (line.trim()) yield parse(line);
        else ++lineNumber;
      }
      if (Buffer.byteLength(pending, 'utf8') > 2 * 1024 * 1024)
        throw new Error(`Corpus line ${lineNumber + 1} exceeds the input budget`);
    }
    if (pending.trim()) yield parse(pending);
  } finally {
    stream.destroy();
  }
}

export async function hashCorpusFile(path: string): Promise<string> {
  await assertPrivateCorpusPath(path, true);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const absolute = await assertPrivateCorpusPath(path, false);
  const file = await open(absolute, 'wx', 0o600);
  let complete = false;
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete) await unlink(absolute).catch(() => undefined);
  }
}

export function wilsonInterval(successes: number, total: number) {
  if (total === 0) return null;
  const zScore = 1.959963984540054;
  const p = successes / total;
  const divisor = 1 + zScore ** 2 / total;
  const center = (p + zScore ** 2 / (2 * total)) / divisor;
  const half =
    (zScore * Math.sqrt((p * (1 - p)) / total + zScore ** 2 / (4 * total ** 2))) / divisor;
  return {
    value: p,
    lower95: Math.max(0, center - half),
    upper95: Math.min(1, center + half),
    total,
  };
}

export function chooseStratifiedChats<
  T extends { chatId: string; stratum: string; events: number },
>(rows: readonly T[], minimum = 20): T[] {
  const strata = new Map<string, T[]>();
  for (const row of rows) {
    const group = strata.get(row.stratum) ?? [];
    group.push(row);
    strata.set(row.stratum, group);
  }
  const selected = new Map<string, T>();
  for (const [, group] of [...strata].sort(([a], [b]) => a.localeCompare(b))) {
    group.sort((a, b) => a.events - b.events || a.chatId.localeCompare(b.chatId));
    const choices =
      group.length <= 5 ? group : [group[0]!, group[Math.floor(group.length / 2)]!, group.at(-1)!];
    for (const row of choices) selected.set(row.chatId, row);
  }
  for (const row of [...rows].sort((a, b) =>
    corpusDigest(a.chatId).localeCompare(corpusDigest(b.chatId)),
  )) {
    if (selected.size >= minimum) break;
    selected.set(row.chatId, row);
  }
  return [...selected.values()].sort((a, b) => a.chatId.localeCompare(b.chatId));
}
