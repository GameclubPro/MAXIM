import { mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { exportAntiduplicateCorpus } from './export-antiduplicate-corpus';

describe('antiduplicate private exporter lifecycle', () => {
  let directory: string;
  const originalUrl = process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maxim-corpus-export-'));
    await chmod(directory, 0o700);
    process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL =
      'postgres://localhost/maxim_antiduplicate_replay_fixture';
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL;
    else process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL = originalUrl;
    await rm(directory, { recursive: true, force: true });
  });
  const args = (path: string) => [
    '--output',
    path,
    '--snapshot-sha256',
    'a'.repeat(64),
    '--snapshot-at',
    '2026-08-27T12:00:00.000Z',
  ];

  it('preserves existing output on exclusive-create failure and closes read-only transaction', async () => {
    const path = join(directory, 'existing.jsonl');
    await writeFile(path, 'existing-private-corpus', { mode: 0o600 });
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('row_to_json'))
        return {
          rows: Array.from({ length: 20 }, (_, index) => ({
            chatId: String(index + 1),
            settings: { anti_duplicate_enabled: true },
          })),
        };
      if (sql.includes('count(*)'))
        return {
          rows: Array.from({ length: 20 }, (_, index) => ({
            chatId: String(index + 1),
            events: '1',
          })),
        };
      return { rows: [] };
    });
    const release = jest.fn();
    jest.spyOn(Pool.prototype, 'connect').mockResolvedValue({ query, release } as never);
    const end = jest.spyOn(Pool.prototype, 'end').mockImplementation(async () => undefined);
    await expect(exportAntiduplicateCorpus(args(path))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('existing-private-corpus');
    expect(query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('closes the pool when isolated snapshot connection fails', async () => {
    jest
      .spyOn(Pool.prototype, 'connect')
      .mockRejectedValue(new Error('snapshot unavailable') as never);
    const end = jest.spyOn(Pool.prototype, 'end').mockImplementation(async () => undefined);
    await expect(exportAntiduplicateCorpus(args(join(directory, 'new.jsonl')))).rejects.toThrow(
      'snapshot unavailable',
    );
    expect(end).toHaveBeenCalledTimes(1);
  });
});
