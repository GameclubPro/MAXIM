#!/usr/bin/env node

import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const MAX_BUNDLE_BYTES = 8 * 1024;
const PUBLISHER_DIALOG_SIGNING_DOMAIN = 'MAXIM Publisher Dialog Links v1';

export function derivePublisherDialogSigningKey(token) {
  return createHmac('sha256', PUBLISHER_DIALOG_SIGNING_DOMAIN).update(token).digest('base64');
}

export function buildPublisherSecretBundle(tokenBytes, botId = 'se14088825_bot') {
  const rawToken = Buffer.isBuffer(tokenBytes) ? tokenBytes.toString('utf8') : String(tokenBytes);
  const token = rawToken.trim();
  if (
    !TOKEN_PATTERN.test(token) ||
    rawToken.trimEnd().includes('\n') ||
    rawToken.includes('\0') ||
    !BOT_ID_PATTERN.test(botId)
  ) {
    throw new Error('Publisher token input is invalid.');
  }

  const secretPath = randomBytes(32).toString('base64url');
  const headerSecret = randomBytes(32).toString('base64url');
  const initDataKey = createHmac('sha256', 'WebAppData').update(token).digest('base64');
  const dialogSigningKey = derivePublisherDialogSigningKey(token);
  return {
    version: 1,
    botId,
    actionToken: token,
    webhook: {
      version: 1,
      botId,
      secretPath,
      headerSecrets: [headerSecret],
    },
    initData: {
      version: 1,
      botId,
      keys: [initDataKey],
    },
    dialogSigning: {
      version: 1,
      botId,
      keys: [dialogSigningKey],
    },
  };
}

export function validatePublisherSecretBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Publisher secret bundle is invalid.');
  }
  const { botId, actionToken, webhook, initData } = value;
  const dialogSigning =
    value.dialogSigning ??
    (typeof actionToken === 'string' &&
    TOKEN_PATTERN.test(actionToken) &&
    typeof botId === 'string' &&
    BOT_ID_PATTERN.test(botId)
      ? {
          version: 1,
          botId,
          keys: [derivePublisherDialogSigningKey(actionToken)],
        }
      : null);
  const decodeKeys = (container) =>
    Array.isArray(container?.keys)
      ? container.keys.map((key) => {
          if (typeof key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) return null;
          const bytes = Buffer.from(key, 'base64');
          return bytes.toString('base64') === key && bytes.length === 32 ? bytes : null;
        })
      : [];
  const decodedKeys = decodeKeys(initData);
  const decodedDialogSigningKeys = decodeKeys(dialogSigning);
  if (
    value.version !== 1 ||
    typeof botId !== 'string' ||
    !BOT_ID_PATTERN.test(botId) ||
    typeof actionToken !== 'string' ||
    !TOKEN_PATTERN.test(actionToken) ||
    webhook?.version !== 1 ||
    webhook?.botId !== botId ||
    typeof webhook?.secretPath !== 'string' ||
    !SECRET_PATTERN.test(webhook.secretPath) ||
    !Array.isArray(webhook?.headerSecrets) ||
    webhook.headerSecrets.length < 1 ||
    webhook.headerSecrets.length > 2 ||
    webhook.headerSecrets.some(
      (secret) => typeof secret !== 'string' || !SECRET_PATTERN.test(secret),
    ) ||
    new Set(webhook.headerSecrets).size !== webhook.headerSecrets.length ||
    initData?.version !== 1 ||
    initData?.botId !== botId ||
    decodedKeys.length < 1 ||
    decodedKeys.length > 2 ||
    decodedKeys.some((key) => key === null) ||
    dialogSigning?.version !== 1 ||
    dialogSigning?.botId !== botId ||
    decodedDialogSigningKeys.length < 1 ||
    decodedDialogSigningKeys.length > 2 ||
    decodedDialogSigningKeys.some((key) => key === null)
  ) {
    throw new Error('Publisher secret bundle fields are invalid.');
  }
  return { ...value, dialogSigning };
}

function writePrivateExclusive(path, contents) {
  const file = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(file, contents);
    fsyncSync(file);
    chmodSync(path, 0o600);
  } finally {
    closeSync(file);
  }
}

function readBoundedJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BUNDLE_BYTES) {
    throw new Error('Publisher secret bundle file is invalid.');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runCli(argv) {
  const [command, ...args] = argv;
  if (command === 'pack') {
    const [tokenPath, botId, outputPath] = args;
    if (!tokenPath || !botId || !outputPath) {
      throw new Error(
        'Usage: publisher-secret-bundle.mjs pack <token-file> <bot-id> <output-file>',
      );
    }
    const tokenStat = lstatSync(tokenPath);
    if (
      !tokenStat.isFile() ||
      tokenStat.isSymbolicLink() ||
      tokenStat.size < 32 ||
      tokenStat.size > 1024
    ) {
      throw new Error('Publisher token file is invalid.');
    }
    const bundle = buildPublisherSecretBundle(readFileSync(tokenPath), botId);
    writePrivateExclusive(resolve(outputPath), `${JSON.stringify(bundle)}\n`);
    return;
  }

  if (command === 'stage') {
    const [bundlePath, outputDirectory] = args;
    if (!bundlePath || !outputDirectory) {
      throw new Error('Usage: publisher-secret-bundle.mjs stage <bundle-file> <output-directory>');
    }
    const bundle = validatePublisherSecretBundle(readBoundedJson(bundlePath));
    mkdirSync(outputDirectory, { mode: 0o700 });
    writePrivateExclusive(join(outputDirectory, 'publik-bot-token'), `${bundle.actionToken}\n`);
    writePrivateExclusive(
      join(outputDirectory, 'publik-webhook.json'),
      `${JSON.stringify(bundle.webhook)}\n`,
    );
    writePrivateExclusive(
      join(outputDirectory, 'publik-init-data-keys.json'),
      `${JSON.stringify(bundle.initData)}\n`,
    );
    writePrivateExclusive(
      join(outputDirectory, 'publik-dialog-signing-keys.json'),
      `${JSON.stringify(bundle.dialogSigning)}\n`,
    );
    return;
  }

  throw new Error('Usage: publisher-secret-bundle.mjs <pack|stage> ...');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
