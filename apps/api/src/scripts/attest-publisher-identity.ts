import {
  readPublisherActionTokenFile,
  readPublisherWebhookCredentialFile,
} from '../publisher/publisher-secret-files';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import {
  extractPublisherRemoteIdentity,
  matchesPublisherRemoteIdentity,
} from '../publisher/publisher-identity-attestation.util';

export const PUBLISHER_ATTESTATION_OK = 'PUBLISHER_IDENTITY_ATTESTED';
export const PUBLISHER_ATTESTATION_FAILED = 'PUBLISHER_IDENTITY_ATTESTATION_FAILED';

const MAX_PROBE_RESPONSE_BYTES = 64 * 1_024;
const MAX_PROBE_TIMEOUT_MS = 5_000;

type ProbeFetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'text'>>;

export async function runPublisherIdentityAttestationProbe(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: ProbeFetch = fetch,
): Promise<boolean> {
  if (
    environment.APP_ROLE?.trim() !== 'publisher' ||
    environment.APP_SERVICE_NAME?.trim() !== 'api-publisher'
  ) {
    return false;
  }

  const publisherBotId = buildPublisherBotDescriptor({
    id: environment.MAX_PUBLISHER_BOT_ID,
  }).id;
  const tokenPath = environment.MAX_PUBLISHER_BOT_TOKEN_FILE?.trim() ?? '';
  const webhookCredentialPath = environment.MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE?.trim() ?? '';
  const apiBaseUrl = normalizeBaseUrl(environment.MAX_API_BASE_URL);
  const webhookBaseUrl = normalizeBaseUrl(
    environment.MAX_WEBHOOK_BASE_URL || environment.APP_BASE_URL,
  );
  if (!tokenPath || !webhookCredentialPath || !apiBaseUrl || !webhookBaseUrl) {
    return false;
  }

  let token: string;
  let webhookCredential;
  try {
    token = readPublisherActionTokenFile(tokenPath);
    webhookCredential = readPublisherWebhookCredentialFile(webhookCredentialPath);
  } catch {
    return false;
  }
  if (webhookCredential.botId !== publisherBotId) {
    return false;
  }

  const expectedWebhookUrl = `${webhookBaseUrl}/api/webhook/max/${encodeURIComponent(
    publisherBotId,
  )}/${encodeURIComponent(webhookCredential.secretPath)}`;
  const identityPayload = await requestProbeJson(fetchImpl, `${apiBaseUrl}/me`, token);
  if (
    identityPayload === null ||
    !matchesPublisherRemoteIdentity(publisherBotId, extractPublisherRemoteIdentity(identityPayload))
  ) {
    return false;
  }

  const subscriptionsPayload = await requestProbeJson(
    fetchImpl,
    `${apiBaseUrl}/subscriptions`,
    token,
  );
  return readSubscriptionRows(subscriptionsPayload).some(
    (row) => normalizeComparableUrl(row.url) === normalizeComparableUrl(expectedWebhookUrl),
  );
}

async function requestProbeJson(
  fetchImpl: ProbeFetch,
  url: string,
  token: string,
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: token },
      redirect: 'manual',
      signal: AbortSignal.timeout(MAX_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const raw = await response.text();
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_PROBE_RESPONSE_BYTES) {
      return null;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readSubscriptionRows(payload: unknown): Array<{ url: string }> {
  const source = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { subscriptions?: unknown }).subscriptions)
      ? ((payload as { subscriptions: unknown[] }).subscriptions ?? [])
      : [];
  return source.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return [];
    }
    const url = (row as { url?: unknown }).url;
    return typeof url === 'string' && url.trim() ? [{ url: url.trim() }] : [];
  });
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/u, '') ?? '';
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:' ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeComparableUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const passed = await runPublisherIdentityAttestationProbe();
  process.stdout.write(`${passed ? PUBLISHER_ATTESTATION_OK : PUBLISHER_ATTESTATION_FAILED}\n`);
  process.exitCode = passed ? 0 : 1;
}

if (require.main === module) {
  void main().catch(() => {
    process.stdout.write(`${PUBLISHER_ATTESTATION_FAILED}\n`);
    process.exitCode = 1;
  });
}
