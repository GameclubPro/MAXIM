import { createHash, createPrivateKey } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  signCommercialOcrEvalCertificationRequestPure,
  validateCommercialOcrEvalCertificationRequestPureForSigning,
  type CommercialOcrEvalCertificationEnvelopePure,
  type CommercialOcrEvalCertificationRequestPure,
} from '../moderation/commercial-ocr/eval/commercial-ocr-eval-certification-pure';

const MAX_CERTIFICATION_REQUEST_BYTES = 256 * 1024;
const MAX_APPROVAL_PRIVATE_KEY_BYTES = 16 * 1024;
const LOWER_SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const USAGE =
  'Usage: --request-file <path> --expected-request-sha256 <64-hex> --approval-private-key-file <owner-only-path>';

export type CommercialOcrCertificationSignerOptions = Readonly<{
  requestFile: string;
  expectedRequestSha256: string;
  approvalPrivateKeyFile: string;
}>;

type CommercialOcrCertificationSignerDependencies = Readonly<{
  readApprovalPrivateKey: (path: string) => Promise<Buffer>;
}>;

const DEFAULT_SIGNER_DEPENDENCIES: CommercialOcrCertificationSignerDependencies = {
  readApprovalPrivateKey: readCommercialOcrApprovalPrivateKey,
};

export function readCommercialOcrCertificationSignerOptions(
  argv: readonly string[],
): CommercialOcrCertificationSignerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name ||
      !value ||
      value.startsWith('--') ||
      values.has(name) ||
      !['--request-file', '--expected-request-sha256', '--approval-private-key-file'].includes(name)
    ) {
      throw new Error(USAGE);
    }
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error(USAGE);
  }
  return {
    requestFile: resolveBoundedPath(values.get('--request-file')),
    expectedRequestSha256: requireCanonicalSha256(values.get('--expected-request-sha256')),
    approvalPrivateKeyFile: resolveBoundedPath(values.get('--approval-private-key-file')),
  };
}

export async function readCommercialOcrCertificationRequest(
  path: string,
  expectedSha256: string,
  issuedAt: string,
): Promise<CommercialOcrEvalCertificationRequestPure> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_CERTIFICATION_REQUEST_BYTES
    ) {
      throw new Error('Commercial OCR certification request must be a bounded regular file');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_CERTIFICATION_REQUEST_BYTES) {
      throw new Error('Commercial OCR certification request must be a bounded regular file');
    }
    if (
      createHash('sha256').update(bytes).digest('hex') !== requireCanonicalSha256(expectedSha256)
    ) {
      throw new Error('Commercial OCR certification request digest does not match review');
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new Error('Commercial OCR certification request is not valid UTF-8 JSON');
    }
    return validateCommercialOcrEvalCertificationRequestPureForSigning(value, issuedAt);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Commercial OCR certification')) {
      throw error;
    }
    throw new Error('Commercial OCR certification request file is unavailable or invalid');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readCommercialOcrApprovalPrivateKey(path: string): Promise<Buffer> {
  let handle;
  let bytes: Buffer | null = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_APPROVAL_PRIVATE_KEY_BYTES ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error('Commercial OCR approval private key file must be owner-only and bounded');
    }
    bytes = await handle.readFile();
    validateCommercialOcrApprovalPrivateKeyBytes(bytes);
    const result = bytes;
    bytes = null;
    return result;
  } catch (error: unknown) {
    bytes?.fill(0);
    if (error instanceof Error && error.message.startsWith('Commercial OCR approval')) {
      throw error;
    }
    throw new Error('Commercial OCR approval private key file is unavailable or invalid');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function validateCommercialOcrApprovalPrivateKeyBytes(bytes: Buffer): void {
  try {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_APPROVAL_PRIVATE_KEY_BYTES) {
      throw new Error('Commercial OCR approval private key file must be owner-only and bounded');
    }
    const privateKey = createPrivateKey(bytes);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Commercial OCR approval private key must be Ed25519');
    }
  } catch (error: unknown) {
    bytes.fill(0);
    if (error instanceof Error && error.message.startsWith('Commercial OCR approval')) {
      throw error;
    }
    throw new Error('Commercial OCR approval private key file is unavailable or invalid');
  }
}

export async function signCommercialOcrCertification(params: {
  request: unknown;
  approvalPrivateKeyFile: string;
  issuedAt: string;
  dependencies?: CommercialOcrCertificationSignerDependencies;
}): Promise<CommercialOcrEvalCertificationEnvelopePure> {
  const request = validateCommercialOcrEvalCertificationRequestPureForSigning(
    params.request,
    params.issuedAt,
  );
  const dependencies = params.dependencies ?? DEFAULT_SIGNER_DEPENDENCIES;
  const approvalPrivateKey = await dependencies.readApprovalPrivateKey(
    params.approvalPrivateKeyFile,
  );
  try {
    return signCommercialOcrEvalCertificationRequestPure({
      request,
      approvalPrivateKey,
      issuedAt: params.issuedAt,
    });
  } finally {
    approvalPrivateKey.fill(0);
  }
}

function resolveBoundedPath(value: string | undefined): string {
  if (!value || value.length > 4_096 || value.includes('\0')) {
    throw new Error(USAGE);
  }
  return resolve(value);
}

function requireCanonicalSha256(value: string | undefined): string {
  if (!value || !LOWER_SHA_256_PATTERN.test(value)) {
    throw new Error(USAGE);
  }
  return value;
}

async function main(): Promise<void> {
  const options = readCommercialOcrCertificationSignerOptions(process.argv.slice(2));
  const issuedAt = new Date().toISOString();
  const request = await readCommercialOcrCertificationRequest(
    options.requestFile,
    options.expectedRequestSha256,
    issuedAt,
  );
  const certification = await signCommercialOcrCertification({
    request,
    approvalPrivateKeyFile: options.approvalPrivateKeyFile,
    issuedAt,
  });
  process.stdout.write(`${JSON.stringify(certification)}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
