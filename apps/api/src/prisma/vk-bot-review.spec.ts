import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

describe('VK bot review migration', () => {
  it('enforces one review per post, independent decisions, private inboxes and indexed recovery', async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        join(__dirname, 'vk-bot-review.pglite.mjs'),
        join(__dirname, '../../prisma/migrations/20260915120000_add_vk_bot_review/migration.sql'),
      ],
      { timeout: 30_000, maxBuffer: 1_000_000 },
    );
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });
});
