import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMERCIAL_OUTPUT_LOCK_STALE_MS,
  assertCommercialOutputLockPathsSafe,
  assertCommercialPathsDistinct,
  withCommercialOutputLocks,
} from './commercial-output-lock.util';

describe('commercial output locks', () => {
  it('rejects path aliases through symlinked parents and hard links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-path-alias-'));
    const realDirectory = join(directory, 'real');
    const aliasDirectory = join(directory, 'alias');
    const inputPath = join(realDirectory, 'input.jsonl');
    const hardLinkPath = join(realDirectory, 'input-hardlink.jsonl');

    try {
      await mkdir(realDirectory);
      await writeFile(inputPath, 'input\n', 'utf8');
      await symlink(realDirectory, aliasDirectory, 'dir');
      await link(inputPath, hardLinkPath);

      await expect(
        assertCommercialPathsDistinct([inputPath, join(aliasDirectory, 'input.jsonl')]),
      ).rejects.toThrow('must resolve to different files');
      await expect(assertCommercialPathsDistinct([inputPath, hardLinkPath])).rejects.toThrow(
        'must resolve to different files',
      );
      await expect(
        assertCommercialPathsDistinct([inputPath, join(aliasDirectory, 'output.jsonl')]),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a concurrent writer and releases every lock afterward', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-'));
    const firstPath = join(directory, 'diff.jsonl');
    const secondPath = join(directory, 'summary.json');
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });

    try {
      const firstRun = withCommercialOutputLocks([firstPath, secondPath], async () => {
        locked();
        await holdFirst;
        return 'first';
      });
      await lockAcquired;

      await expect(
        withCommercialOutputLocks([secondPath, firstPath], async () => 'second'),
      ).rejects.toThrow('Output is locked by another process');
      expect(JSON.parse(await readFile(`${firstPath}.lock`, 'utf8'))).toEqual(
        expect.objectContaining({ pid: process.pid }),
      );

      releaseFirst();
      await expect(firstRun).resolves.toBe('first');
      await expect(readFile(`${firstPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(`${secondPath}.lock`, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        withCommercialOutputLocks([firstPath, secondPath], async () => 'third'),
      ).resolves.toBe('third');
    } finally {
      releaseFirst();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases locks when publication fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-error-'));
    const outputPath = join(directory, 'diff.jsonl');

    try {
      await expect(
        withCommercialOutputLocks([outputPath], async () => {
          throw new Error('publication failed');
        }),
      ).rejects.toThrow('publication failed');
      await expect(readFile(`${outputPath}.lock`, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers an old same-owner lock only after its process is gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-stale-'));
    const outputPath = join(directory, 'diff.jsonl');
    const lockPath = `${outputPath}.lock`;
    const oldDate = new Date(Date.now() - COMMERCIAL_OUTPUT_LOCK_STALE_MS - 60_000);

    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: 999_999_999, createdAt: oldDate.toISOString() })}\n`,
        { mode: 0o600 },
      );
      await utimes(lockPath, oldDate, oldDate);

      await expect(withCommercialOutputLocks([outputPath], async () => 'recovered')).resolves.toBe(
        'recovered',
      );
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(`${lockPath}.recovery`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers when a stale dead process also left an orphan recovery lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-orphan-recovery-'));
    const outputPath = join(directory, 'diff.jsonl');
    const lockPath = `${outputPath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    const oldDate = new Date(Date.now() - COMMERCIAL_OUTPUT_LOCK_STALE_MS - 60_000);
    const staleMetadata = `${JSON.stringify({
      pid: 999_999_999,
      createdAt: oldDate.toISOString(),
    })}\n`;

    try {
      await writeFile(lockPath, staleMetadata, { mode: 0o600 });
      await writeFile(recoveryPath, staleMetadata, { mode: 0o600 });
      await utimes(lockPath, oldDate, oldDate);
      await utimes(recoveryPath, oldDate, oldDate);

      await expect(withCommercialOutputLocks([outputPath], async () => 'recovered')).resolves.toBe(
        'recovered',
      );
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(recoveryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps fresh dead-process locks and old live-process locks fail-closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-conservative-'));
    const freshOutput = join(directory, 'fresh.jsonl');
    const liveOutput = join(directory, 'live.jsonl');
    const oldDate = new Date(Date.now() - COMMERCIAL_OUTPUT_LOCK_STALE_MS - 60_000);

    try {
      await writeFile(
        `${freshOutput}.lock`,
        `${JSON.stringify({ pid: 999_999_999, createdAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        `${liveOutput}.lock`,
        `${JSON.stringify({ pid: process.pid, createdAt: oldDate.toISOString() })}\n`,
        { mode: 0o600 },
      );
      await utimes(`${liveOutput}.lock`, oldDate, oldDate);

      await expect(
        withCommercialOutputLocks([freshOutput], async () => 'unexpected'),
      ).rejects.toThrow('Output is locked by another process');
      await expect(
        withCommercialOutputLocks([liveOutput], async () => 'unexpected'),
      ).rejects.toThrow('Output is locked by another process');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an output path that aliases another output lock path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-collision-'));
    const outputPath = join(directory, 'diff.jsonl');

    try {
      await expect(
        assertCommercialOutputLockPathsSafe([outputPath, `${outputPath}.lock`]),
      ).rejects.toThrow('collides with an output lock path');
      await expect(
        withCommercialOutputLocks([outputPath, `${outputPath}.lock`], async () => 'unexpected'),
      ).rejects.toThrow('collides with an output lock path');
      expect(await stat(directory)).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects output-to-lock collisions through symlinked parents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-symlink-collision-'));
    const realDirectory = join(directory, 'real');
    const aliasDirectory = join(directory, 'alias');
    const outputPath = join(realDirectory, 'diff.jsonl');
    const collidingOutputPath = join(aliasDirectory, 'diff.jsonl.lock');

    try {
      await mkdir(realDirectory);
      await symlink(realDirectory, aliasDirectory, 'dir');

      await expect(
        assertCommercialOutputLockPathsSafe([outputPath, collidingOutputPath]),
      ).rejects.toThrow('collides with an output lock path');
      await expect(
        withCommercialOutputLocks([outputPath, collidingOutputPath], async () => 'unexpected'),
      ).rejects.toThrow('collides with an output lock path');
      await expect(stat(`${outputPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an output hard-linked to another output lock path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-hardlink-collision-'));
    const outputPath = join(directory, 'diff.jsonl');
    const lockPath = `${outputPath}.lock`;
    const collidingOutputPath = join(directory, 'summary.json');

    try {
      await writeFile(lockPath, 'existing lock\n', 'utf8');
      await link(lockPath, collidingOutputPath);

      await expect(
        assertCommercialOutputLockPathsSafe([outputPath, collidingOutputPath]),
      ).rejects.toThrow('collides with an output lock path');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['replaced inode', 'overwritten token'] as const)(
    'does not delete a foreign lock with a %s during release',
    async (replacementMode) => {
      const directory = await mkdtemp(join(tmpdir(), 'commercial-output-lock-ownership-'));
      const outputPath = join(directory, 'diff.jsonl');
      const lockPath = `${outputPath}.lock`;
      const foreignMetadata = `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token: 'foreign-token',
      })}\n`;

      try {
        await expect(
          withCommercialOutputLocks([outputPath], async () => {
            if (replacementMode === 'replaced inode') {
              await unlink(lockPath);
            }
            await writeFile(lockPath, foreignMetadata, { mode: 0o600 });
          }),
        ).rejects.toThrow('Commercial output lock cleanup failed');

        expect(await readFile(lockPath, 'utf8')).toBe(foreignMetadata);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
