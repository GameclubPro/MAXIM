import { mkdtemp, chmod, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANTIDUPLICATE_CORPUS_VERSION,
  antiduplicateCorpusManifestSchema,
  antiduplicateCorpusEndSchema,
  antiduplicateCorpusEventSchema,
  assertDistinctCorpusPaths,
  assertPrivateCorpusPath,
  assertLocalReplayUrl,
  corpusTimestamp,
  normalizeCorpusSettings,
  readCorpusLines,
  writePrivateJson,
} from './antiduplicate-corpus';
import {
  corpusEventFromSourceRow,
  inspectCorpusSourceRow,
  pseudonymizeCorpusRaw,
} from './export-antiduplicate-corpus';
import { buildOfflineDuplicateScript } from './replay-antiduplicate-corpus';
import { MESSAGE_DUPLICATE_WINDOW_SCRIPT } from '../moderation/message-duplicate/message-duplicate-window.script';

describe('private antiduplicate corpus boundaries', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maxim-corpus-unit-'));
    await chmod(directory, 0o700);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = () => ({
    type: 'MANIFEST',
    version: ANTIDUPLICATE_CORPUS_VERSION,
    sourceSnapshotSha256: 'a'.repeat(64),
    sourceSnapshotAt: '2026-08-27T12:00:00.000Z',
    warmupFrom: '2026-08-13T00:00:00.000Z',
    from: '2026-08-20T00:00:00.000Z',
    until: '2026-08-27T00:00:00.000Z',
    holdoutFrom: '2026-08-25T00:00:00.000Z',
    settingsBasis: 'SNAPSHOT_REPLAY',
    cohortComplete: false,
    sourceComplete: false,
    selectedChats: 1,
    eligibleChats: 3,
    settings: { '-123': {} },
  });
  const sourceRow = (override: Record<string, unknown> = {}) => ({
    id: 'receipt-1',
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    normalized: {
      type: 'message_created',
      eventTimestampSource: 'payload',
      message: { chatId: '-123', senderId: '123', messageId: 'message-1' },
    },
    raw: {
      update_type: 'message_created',
      timestamp: Date.parse('2026-08-20T10:00:00.000Z'),
      message: {
        sender: { user_id: 123, name: 'Private Person' },
        recipient: { chat_id: -123 },
        timestamp: Date.parse('2026-08-20T09:59:59.000Z'),
        body: {
          mid: 'message-1',
          text: 'Заказ 12345678, +7 999 123-45-67 https://example.test/offer',
        },
      },
    },
    ...override,
  });

  it('projects duplicate policy before validating unrelated historical settings', () => {
    const settings = normalizeCorpusSettings({
      antiDuplicateEnabled: true,
      duplicateCompareMode: 'TEXT',
      duplicateDetectionPreset: 'STRICT',
      nightModeBotButtons: [{ text: 'old invalid button', url: 'historical-invalid-url' }],
      chatId: '-123',
      privateOtherSetting: 'must not enter corpus',
    });
    expect(settings).toMatchObject({
      antiDuplicateEnabled: true,
      duplicateCompareMode: 'TEXT',
      duplicateDetectionPreset: 'STRICT',
    });
    expect(
      Object.keys(settings).every(
        (key) => key === 'antiDuplicateEnabled' || key.startsWith('duplicate'),
      ),
    ).toBe(true);
    expect(settings).not.toHaveProperty('nightModeBotButtons');
    expect(() => normalizeCorpusSettings({ duplicateCompareMode: 'INVALID' })).toThrow();
    expect(() => normalizeCorpusSettings({ duplicatePolicyRevision: '1' })).toThrow();
  });

  it('requires complete UTC evaluation/warmup days, two holdout days and truthful counts', () => {
    expect(antiduplicateCorpusManifestSchema.safeParse(manifest()).success).toBe(true);
    for (const change of [
      { from: '2026-08-20T01:00:00.000Z' },
      { warmupFrom: '2026-08-14T00:00:00.000Z' },
      { holdoutFrom: '2026-08-26T00:00:00.000Z' },
      { selectedChats: 2 },
      { eligibleChats: 0 },
    ])
      expect(
        antiduplicateCorpusManifestSchema.safeParse({ ...manifest(), ...change }).success,
      ).toBe(false);
    expect(
      antiduplicateCorpusEndSchema.safeParse({
        type: 'END',
        scanned: 2,
        exported: 2,
        rejected: 0,
        saturated: false,
        sourceComplete: true,
      }).success,
    ).toBe(true);
    expect(
      antiduplicateCorpusEndSchema.safeParse({
        type: 'END',
        scanned: 3,
        exported: 2,
        rejected: 0,
        saturated: false,
        sourceComplete: true,
      }).success,
    ).toBe(false);
    expect(
      antiduplicateCorpusEndSchema.safeParse({
        type: 'END',
        scanned: 3,
        exported: 2,
        rejected: 1,
        saturated: false,
        sourceComplete: true,
      }).success,
    ).toBe(false);
  });

  it('reads physical LF only with Unicode separators across chunks and missing final newline', async () => {
    const records = [
      { text: `${'я'.repeat(33000)}\u2028строка\u2029абзац` },
      { nested: { text: '\u2028\u2029' } },
    ];
    const path = join(directory, 'unicode.jsonl');
    await writeFile(path, records.map((value) => JSON.stringify(value)).join('\r\n'), {
      mode: 0o600,
    });
    const read: unknown[] = [];
    for await (const value of readCorpusLines(path)) read.push(value);
    expect(read).toEqual(records);
  });

  it('rejects public/symlink paths and canonical/hardlinked aliases', async () => {
    const input = join(directory, 'input.jsonl');
    const hardlink = join(directory, 'linked.jsonl');
    await writeFile(input, '{}\n', { mode: 0o600 });
    await link(input, hardlink);
    await expect(
      assertDistinctCorpusPaths([
        { path: input, existing: true },
        { path: hardlink, existing: true },
      ]),
    ).rejects.toThrow('alias');
    await expect(
      assertDistinctCorpusPaths([
        { path: input, existing: true },
        { path: join(directory, '.', 'input.jsonl'), existing: false },
      ]),
    ).rejects.toThrow('distinct');
    const symbolic = join(directory, 'symbolic.jsonl');
    await symlink(input, symbolic);
    await expect(assertPrivateCorpusPath(symbolic, true)).rejects.toThrow('private regular');
    await chmod(input, 0o644);
    await expect(assertPrivateCorpusPath(input, true)).rejects.toThrow('private regular');
    await chmod(directory, 0o755);
    await expect(assertPrivateCorpusPath(input, false)).rejects.toThrow('owner-private');
  });

  it('never overwrites or deletes an existing private output', async () => {
    const path = join(directory, 'result.json');
    await writeFile(path, 'valuable-existing-data', { mode: 0o600 });
    await expect(writePrivateJson(path, { replacement: true })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(path, 'utf8')).toBe('valuable-existing-data');
  });

  it('normalizes trusted timestamps and rejects non-disposable stores', () => {
    expect(corpusTimestamp(1787220000)).toBe('2026-08-20T10:00:00.000Z');
    expect(corpusTimestamp(new Date('2026-08-20T10:00:00Z'))).toBe('2026-08-20T10:00:00.000Z');
    expect(corpusTimestamp('bad')).toBeNull();
    expect(() => assertLocalReplayUrl('postgres://localhost/maxim_production', 'postgres')).toThrow(
      'non-disposable',
    );
    expect(() => assertLocalReplayUrl('redis://example.test:6379', 'redis')).toThrow('loopback');
    expect(
      assertLocalReplayUrl('postgres://localhost/maxim_antiduplicate_replay_test', 'postgres')
        .hostname,
    ).toBe('localhost');
  });

  it('exports raw/frozen agreement with genuine author, publication and receipt provenance', () => {
    const event = corpusEventFromSourceRow(sourceRow(), 'a'.repeat(64));
    expect(event).toMatchObject({
      eventAt: '2026-08-20T10:00:00.000Z',
      receivedAt: '2026-08-20T10:00:00.000Z',
      publishedAt: '2026-08-20T09:59:59.000Z',
      historicalAction: 'UNKNOWN',
    });
    expect(event!.chatId).not.toBe('-123');
    expect(event!.userId).not.toBe('123');
    expect(JSON.stringify(event!.raw)).not.toContain('Private Person');
    expect(JSON.stringify(event!.raw)).toContain('Заказ 12345678, +7 999 123-45-67');
    expect(
      corpusEventFromSourceRow(
        sourceRow({
          normalized: {
            type: 'message_created',
            eventTimestampSource: 'payload',
            message: { chatId: '-123', messageId: 'message-1' },
          },
        }),
        'a'.repeat(64),
      ),
    ).toBeNull();
    expect(
      corpusEventFromSourceRow(
        sourceRow({
          normalized: {
            type: 'message_created',
            eventTimestampSource: 'ingress',
            message: { chatId: '-123', senderId: '123', messageId: 'message-1' },
          },
        }),
        'a'.repeat(64),
      ),
    ).toBeNull();
    expect(
      corpusEventFromSourceRow(
        sourceRow({
          normalized: {
            type: 'message_created',
            eventTimestampSource: 'payload',
            message: { chatId: '-456', senderId: '123', messageId: 'message-1' },
          },
        }),
        'a'.repeat(64),
      ),
    ).toBeNull();
    expect(antiduplicateCorpusEventSchema.safeParse({ ...event, userId: null }).success).toBe(
      false,
    );
  });

  it('pseudonymizes contextual numeric entities without touching private comparison text', () => {
    const pseudonymous = pseudonymizeCorpusRaw(
      {
        sender: { id: 123, name: 'Person' },
        recipient: { id: -456 },
        body: { text: '123', order: { id: 'business-id' } },
      },
      'salt',
    );
    expect(pseudonymous).toMatchObject({ body: { text: '123', order: { id: 'business-id' } } });
    expect(pseudonymous.sender).not.toMatchObject({ id: 123 });
    expect(pseudonymous.sender).not.toHaveProperty('name');
  });

  it.each([
    'message.seq',
    'message.id',
    'body.seq',
    'body.id',
    'content.seq',
    'content.id',
    'data.id',
  ])('preserves canonical source identity through pseudonymization of %s', (path) => {
    const row = sourceRow();
    const message = row.raw.message;
    const [container, field] = path.split('.') as [string, string];
    delete (message.body as Partial<typeof message.body>).mid;
    const canonical =
      container === 'message'
        ? (message as Record<string, unknown>)
        : (((message as Record<string, unknown>)[container] ??= {}) as Record<string, unknown>);
    canonical[field] = 'canonical-source-identity';
    row.normalized.message.messageId = 'canonical-source-identity';
    (message.body as Record<string, unknown>).attachments = [
      { type: 'file', payload: { id: 'attachment-content-id', url: 'https://example.test/file' } },
    ];
    (message.body as Record<string, unknown>).buttons = [
      { id: 'navigation-content-id', payload: 'literal-callback-payload' },
    ];
    const inspected = inspectCorpusSourceRow(row, 'a'.repeat(64));
    expect(inspected.rejection).toBeNull();
    expect(inspected.event).not.toBeNull();
    expect(JSON.stringify(inspected.event!.raw)).toContain('attachment-content-id');
    expect(JSON.stringify(inspected.event!.raw)).toContain('navigation-content-id');
    expect(JSON.stringify(inspected.event!.raw)).toContain('literal-callback-payload');
    expect(JSON.stringify(inspected.event!.raw)).not.toContain('canonical-source-identity');
  });

  it('classifies source/raw mismatches before hashing identities', () => {
    const row = sourceRow();
    row.normalized.message.messageId = 'different-frozen-identity';
    expect(inspectCorpusSourceRow(row, 'a'.repeat(64))).toEqual({
      event: null,
      rejection: 'SOURCE_IDENTITY_MISMATCH',
    });
    expect(inspectCorpusSourceRow(sourceRow({ raw: {} }), 'a'.repeat(64))).toEqual({
      event: null,
      rejection: 'RAW_SOURCE_MISSING',
    });
  });

  it('refuses instrumentation when any production window source changes', () => {
    expect(buildOfflineDuplicateScript()).toContain('replayNowMs');
    expect(() =>
      buildOfflineDuplicateScript(`${MESSAGE_DUPLICATE_WINDOW_SCRIPT}\n-- changed`),
    ).toThrow('requires review');
  });
});
