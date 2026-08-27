import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const MAX_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const MAX_TOKEN_FILE_MAX_BYTES = 1_024;

const webhookCredentialSchema = z.object({
  version: z.literal(1),
  botId: z.string().trim().min(3),
  secretPath: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,128}$/u),
  headerSecrets: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{16,128}$/u),
    )
    .min(1)
    .max(2),
});

const initDataKeysSchema = z.object({
  version: z.literal(1),
  botId: z.string().trim().min(3),
  keys: z.array(z.string().trim().min(43).max(44)).min(1).max(2),
});

const dialogSigningKeysSchema = initDataKeysSchema;

export type PublisherWebhookCredential = z.infer<typeof webhookCredentialSchema>;
export type PublisherInitDataKeys = z.infer<typeof initDataKeysSchema>;
export type PublisherDialogSigningKeys = z.infer<typeof dialogSigningKeysSchema>;

export function readPublisherActionTokenFile(path: string): string {
  assertAbsoluteRegularSecretFile(path, 32, MAX_TOKEN_FILE_MAX_BYTES, 'bot token');
  const raw = readFileSync(path, 'utf8');
  const token = raw.trim();
  if (!MAX_TOKEN_PATTERN.test(token) || raw.trimEnd().includes('\n') || raw.includes('\0')) {
    throw new Error('MAX publisher bot token file contains an invalid token');
  }
  return token;
}

export function readPublisherWebhookCredentialFile(path: string): PublisherWebhookCredential {
  assertAbsoluteRegularSecretFile(path, 32, 2_048, 'webhook credential');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('MAX publisher webhook credential file is not valid JSON');
  }
  const parsed = webhookCredentialSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.headerSecrets).size !== parsed.data.headerSecrets.length
  ) {
    throw new Error('MAX publisher webhook credential file has invalid fields');
  }
  return parsed.data;
}

export function readPublisherInitDataKeysFile(path: string): PublisherInitDataKeys {
  return readPublisherBase64KeysFile(path, initDataKeysSchema, 'init data keys');
}

export function readPublisherDialogSigningKeysFile(path: string): PublisherDialogSigningKeys {
  return readPublisherBase64KeysFile(path, dialogSigningKeysSchema, 'dialog signing keys');
}

function readPublisherBase64KeysFile<T extends PublisherInitDataKeys>(
  path: string,
  schema: typeof initDataKeysSchema,
  label: string,
): T {
  assertAbsoluteRegularSecretFile(path, 64, 1_024, label);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`MAX publisher ${label} file is not valid JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`MAX publisher ${label} file has invalid fields`);
  }
  const keys = parsed.data.keys.map((key) => key.trim());
  const decodedKeys = keys.map((key) => Buffer.from(key, 'base64'));
  if (
    decodedKeys.some(
      (key, index) =>
        key.length !== 32 ||
        key.toString('base64').replace(/=+$/u, '') !== keys[index]?.replace(/=+$/u, ''),
    )
  ) {
    throw new Error(`MAX publisher ${label} file contains an invalid key`);
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error(`MAX publisher ${label} file repeats a key`);
  }
  return { ...parsed.data, keys } as T;
}

function assertAbsoluteRegularSecretFile(
  path: string,
  minBytes: number,
  maxBytes: number,
  label: string,
): void {
  if (!isAbsolute(path)) {
    throw new Error(`MAX publisher ${label} file path must be absolute`);
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`MAX publisher ${label} file is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minBytes || stat.size > maxBytes) {
    throw new Error(`MAX publisher ${label} file is invalid`);
  }
}
