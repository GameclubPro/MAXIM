import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPublisherActionTokenFile,
  readPublisherInitDataKeysFile,
  readPublisherWebhookCredentialFile,
} from './publisher-secret-files';

describe('publisher secret files', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'maxim-publisher-secrets-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads a single URL-safe action token without exposing it through metadata', () => {
    const path = join(directory, 'token');
    const token = 'A'.repeat(40);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });

    expect(readPublisherActionTokenFile(path)).toBe(token);
  });

  it('rejects token symlinks and multiline values', () => {
    const target = join(directory, 'target');
    const link = join(directory, 'link');
    writeFileSync(target, `${'A'.repeat(40)}\n${'B'.repeat(40)}\n`, { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => readPublisherActionTokenFile(link)).toThrow(/invalid/u);
    expect(() => readPublisherActionTokenFile(target)).toThrow(/invalid token/u);
  });

  it('loads bounded webhook credentials with optional rotation secret', () => {
    const path = join(directory, 'webhook.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        botId: 'se14088825_bot',
        secretPath: 'p'.repeat(24),
        headerSecrets: ['h'.repeat(24), 'o'.repeat(24)],
      }),
      { mode: 0o600 },
    );

    expect(readPublisherWebhookCredentialFile(path)).toEqual({
      version: 1,
      botId: 'se14088825_bot',
      secretPath: 'p'.repeat(24),
      headerSecrets: ['h'.repeat(24), 'o'.repeat(24)],
    });
  });

  it('loads one or two derived 32-byte init data keys', () => {
    const path = join(directory, 'init-data.json');
    const keys = [Buffer.alloc(32, 1).toString('base64'), Buffer.alloc(32, 2).toString('base64')];
    writeFileSync(path, JSON.stringify({ version: 1, botId: 'se14088825_bot', keys }), {
      mode: 0o600,
    });

    expect(readPublisherInitDataKeysFile(path)).toEqual({
      version: 1,
      botId: 'se14088825_bot',
      keys,
    });
  });
});
