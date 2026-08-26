import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublisherActionCredentialService } from './publisher-action-credential.service';

describe('PublisherActionCredentialService', () => {
  const originalRole = process.env.APP_ROLE;
  const originalService = process.env.APP_SERVICE_NAME;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'maxim-publisher-action-'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
    if (originalService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = originalService;
  });

  it('serves only the configured Publik credential', () => {
    const path = join(directory, 'token');
    const token = 'T'.repeat(40);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    const config = new ConfigService({
      MAX_PUBLISHER_BOT_ID: 'se14088825_bot',
      MAX_PUBLISHER_BOT_TOKEN_FILE: path,
    });
    const service = new PublisherActionCredentialService(config);

    expect(service.getRequiredActionToken('se14088825_bot')).toBe(token);
    expect(() => service.getRequiredActionToken('main-bot')).toThrow(/not authorized/u);
  });

  it('refuses to load the action credential outside api-publisher', () => {
    process.env.APP_ROLE = 'action';
    const config = new ConfigService({
      MAX_PUBLISHER_BOT_ID: 'se14088825_bot',
      MAX_PUBLISHER_BOT_TOKEN_FILE: join(directory, 'missing'),
    });

    expect(() => new PublisherActionCredentialService(config)).toThrow(/only be loaded/u);
  });
});
