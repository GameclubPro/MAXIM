import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublisherWebhookCredentialService } from './publisher-webhook-credential.service';

describe('PublisherWebhookCredentialService', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'maxim-publisher-webhook-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('authenticates Publik webhook without an action token', () => {
    const path = join(directory, 'webhook.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        botId: 'se14088825_bot',
        secretPath: 'path_1234567890123456',
        headerSecrets: ['header_12345678901234'],
      }),
      { mode: 0o600 },
    );
    const service = new PublisherWebhookCredentialService(
      new ConfigService({
        MAX_PUBLISHER_BOT_ID: 'se14088825_bot',
        MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE: path,
      }),
    );

    expect(
      service.resolveWebhookBot({
        botId: 'se14088825_bot',
        secretPath: 'path_1234567890123456',
        providedHeaderSecret: 'header_12345678901234',
      }),
    ).toEqual({ id: 'se14088825_bot', label: 'Публик', kind: 'publisher' });
    expect(
      service.resolveWebhookBot({
        botId: 'se14088825_bot',
        secretPath: 'path_1234567890123456',
        providedHeaderSecret: 'wrong-secret-value',
      }),
    ).toBeNull();
  });
});
