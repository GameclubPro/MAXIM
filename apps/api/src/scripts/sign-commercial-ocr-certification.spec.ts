import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  readCommercialOcrApprovalPrivateKey,
  readCommercialOcrCertificationRequest,
  readCommercialOcrCertificationSignerOptions,
  validateCommercialOcrApprovalPrivateKeyBytes,
} from './sign-commercial-ocr-certification';

describe('commercial OCR certification signer CLI', () => {
  it('requires the frozen request digest and owner-only key path exactly once', () => {
    expect(
      readCommercialOcrCertificationSignerOptions([
        '--request-file',
        './request.json',
        '--expected-request-sha256',
        'a'.repeat(64),
        '--approval-private-key-file',
        './approval.pem',
      ]),
    ).toEqual({
      requestFile: resolve('./request.json'),
      expectedRequestSha256: 'a'.repeat(64),
      approvalPrivateKeyFile: resolve('./approval.pem'),
    });
    expect(() =>
      readCommercialOcrCertificationSignerOptions([
        '--request-file',
        './request.json',
        '--expected-request-sha256',
        'A'.repeat(64),
        '--approval-private-key-file',
        './approval.pem',
      ]),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrCertificationSignerOptions([
        '--request-file',
        './request.json',
        '--request-file',
        './other.json',
        '--expected-request-sha256',
        'a'.repeat(64),
        '--approval-private-key-file',
        './approval.pem',
      ]),
    ).toThrow(/Usage/u);
  });

  it('reads only a bounded owner-only Ed25519 private key file and clears rejected bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-ocr-approval-'));
    const path = join(directory, 'approval.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    try {
      await writeFile(path, pem, { mode: 0o600 });
      await expect(readCommercialOcrApprovalPrivateKey(path)).resolves.toEqual(Buffer.from(pem));

      await chmod(path, 0o644);
      await expect(readCommercialOcrApprovalPrivateKey(path)).rejects.toThrow(/owner-only/u);

      await writeFile(path, Buffer.alloc(16 * 1024 + 1), { mode: 0o600 });
      await chmod(path, 0o600);
      await expect(readCommercialOcrApprovalPrivateKey(path)).rejects.toThrow(/bounded/u);

      const rejectedBytes = Buffer.from('not-a-private-key');
      await writeFile(path, rejectedBytes, { mode: 0o600 });
      await expect(readCommercialOcrApprovalPrivateKey(path)).rejects.toThrow(/unavailable or invalid/u);

      const observableRejectedBytes = Buffer.from('not-a-private-key');
      expect(() => validateCommercialOcrApprovalPrivateKeyBytes(observableRejectedBytes)).toThrow(
        /unavailable or invalid/u,
      );
      expect(observableRejectedBytes.equals(Buffer.alloc(observableRejectedBytes.byteLength))).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a request whose exact bytes do not match the reviewed digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-ocr-request-'));
    const path = join(directory, 'request.json');
    const bytes = Buffer.from('{}\n', 'utf8');
    try {
      await writeFile(path, bytes, { mode: 0o600 });
      await expect(
        readCommercialOcrCertificationRequest(
          path,
          createHash('sha256').update(Buffer.from('{"changed":true}\n')).digest('hex'),
          '2026-08-14T00:00:00.000Z',
        ),
      ).rejects.toThrow(/digest does not match review/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the production signer graph free of OCR, Sharp, and subprocess modules', async () => {
    const sources = await Promise.all(
      [
        resolve(__dirname, 'sign-commercial-ocr-certification.ts'),
        resolve(
          __dirname,
          '../moderation/commercial-ocr/eval/commercial-ocr-eval-certification-pure.ts',
        ),
        resolve(__dirname, '../moderation/commercial-ocr/eval/commercial-ocr-eval-canonical.ts'),
        resolve(__dirname, '../moderation/commercial-ocr/commercial-ocr-settings-profile.ts'),
      ].map((path) => readFile(path, 'utf8')),
    );
    const productionGraph = sources.join('\n');

    expect(productionGraph).not.toMatch(/(?:node:)?child_process/u);
    expect(productionGraph).not.toMatch(/from ['"]sharp['"]/u);
    expect(productionGraph).not.toMatch(/commercial-ocr-eval-runner/u);
    expect(productionGraph).not.toMatch(/native-tesseract/u);
    expect(productionGraph).not.toMatch(/commercial-ocr-behavior-identity/u);
  });
});
