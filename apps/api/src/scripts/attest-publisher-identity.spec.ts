import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPublisherIdentityAttestationProbe } from './attest-publisher-identity';

describe('publisher identity attestation rollout probe', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'maxim-publisher-attestation-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function createEnvironment(): NodeJS.ProcessEnv {
    const tokenPath = join(directory, 'token');
    const webhookPath = join(directory, 'webhook.json');
    writeFileSync(tokenPath, `${'T'.repeat(40)}\n`, { mode: 0o600 });
    writeFileSync(
      webhookPath,
      JSON.stringify({
        version: 1,
        botId: 'se14088825_bot',
        secretPath: 'publisher-webhook-secret',
        headerSecrets: ['publisher-header-secret'],
      }),
      { mode: 0o600 },
    );
    return {
      APP_ROLE: 'publisher',
      APP_SERVICE_NAME: 'api-publisher',
      MAX_PUBLISHER_BOT_ID: 'se14088825_bot',
      MAX_PUBLISHER_BOT_TOKEN_FILE: tokenPath,
      MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE: webhookPath,
      MAX_API_BASE_URL: 'https://platform-api2.max.ru',
      MAX_WEBHOOK_BASE_URL: 'https://major-maksimov.ru',
    };
  }

  it('passes only after exact identity and webhook target confirmation', async () => {
    const fetchImpl = jest.fn(async (url: string) => ({
      ok: true,
      text: async () =>
        JSON.stringify(
          url.endsWith('/me')
            ? { user_id: 14088825, username: 'se14088825_bot' }
            : {
                subscriptions: [
                  {
                    url: 'https://major-maksimov.ru/api/webhook/max/se14088825_bot/publisher-webhook-secret',
                  },
                ],
              },
        ),
    }));

    await expect(
      runPublisherIdentityAttestationProbe(createEnvironment(), fetchImpl),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://platform-api2.max.ru/me',
      expect.objectContaining({
        headers: { Authorization: 'T'.repeat(40) },
        redirect: 'manual',
      }),
    );
  });

  it('fails without querying subscriptions when the token belongs to another bot', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ user_id: 999999, username: 'another_bot' }),
    }));

    await expect(
      runPublisherIdentityAttestationProbe(createEnvironment(), fetchImpl),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
