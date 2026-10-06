import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import {
  legacyRecoveryLiveDigest,
  type LegacyRecoveryLiveOutput,
} from './legacy-recovery-live-protocol';
import {
  assertLegacyRecoveryStoreEnvironment,
  legacyRecoveryStorePoolConfig,
  parseLegacyRecoveryStoreRequest,
  readLegacyRecoveryInventoryFile,
  readLegacyRecoveryStoreStdin,
  verifyLegacyRecoveryInventory,
} from './legacy-recovery-store';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const sourceSha = 'a'.repeat(40),
    imageId = `sha256:${'b'.repeat(64)}`;
  const binding = {
    maintenanceId: '11111111-1111-4111-8111-111111111111',
    queueFenceNonce: '22222222-2222-4222-8222-222222222222',
    transitionJournalSha256: sha('journal'),
    sourceSha,
    imageId,
    stoppedGenerations: [
      ...RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all'),
      'ocr-native-sandbox',
      'photo-native-sandbox',
    ].map((serviceName) => ({
      serviceName,
      containerId: sha(serviceName),
      sourceSha,
      imageId,
      stopped: true,
    })),
  };
  const selection = { ownerWebhookEventIds: ['owner-1'], majorBotIds: ['major-1'] };
  const request = parseLegacyRecoveryStoreRequest(
    JSON.stringify({
      version: 1,
      operation: 'readback',
      certificateId: '33333333-3333-4333-8333-333333333333',
      binding,
      selection,
      expected: {
        inventorySha256: sha('inventory'),
        inventoryArtifactSha256: sha('artifact'),
        previewSha256: sha('preview'),
      },
    }),
  );
  const output: LegacyRecoveryLiveOutput = {
    version: 1,
    operation: 'inventory_preview',
    applied: false,
    activationAuthorized: false,
    decision: 'READY_TO_INSTALL',
    binding: request.binding,
    selectionSha256: legacyRecoveryLiveDigest(request.selection),
    registrySha256: sha('registry'),
    inventorySha256: request.expected.inventorySha256,
    previewSha256: request.expected.previewSha256,
    selectedOwners: [
      {
        ownerWebhookEventId: 'owner-1',
        semanticKey: 'semantic-1',
        claimId: 'claim-1',
        chatId: '-chat',
        messageId: 'message',
        userId: 'user',
        sourceAt: new Date(0).toISOString(),
        rawPayloadSha256: sha('raw'),
        normalizedPayloadSha256: sha('normalized'),
        ownerSnapshotSha256: sha('owner'),
        claimSnapshotSha256: sha('claim'),
      },
    ],
    children: [],
    sqlPlans: [],
    issues: [],
    cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
  };
  const bytes = Buffer.from(`${JSON.stringify(output)}\n`);
  return {
    request: {
      ...request,
      expected: { ...request.expected, inventoryArtifactSha256: sha(bytes.toString()) },
    },
    output,
    bytes,
  };
}
describe('standalone legacy recovery store protocol', () => {
  it('accepts the exact finite stopped generation and rejects extra or unbounded inputs', () => {
    const { request } = fixture();
    expect(parseLegacyRecoveryStoreRequest(JSON.stringify(request))).toEqual(request);
    const malformed = [
      { ...request, unknown: true },
      { ...request, certificateId: 'not-a-uuid' },
      {
        ...request,
        selection: { ...request.selection, ownerWebhookEventIds: Array(201).fill('owner') },
      },
      { ...request, selection: { ...request.selection, majorBotIds: Array(101).fill('bot') } },
      {
        ...request,
        binding: {
          ...request.binding,
          stoppedGenerations: request.binding.stoppedGenerations.slice(1),
        },
      },
      { ...request, operation: 'materialize', page: { chatId: '-chat', pageSize: 201 } },
      { ...request, page: { chatId: '-chat', pageSize: 1 } },
    ];
    for (const input of malformed)
      expect(() => parseLegacyRecoveryStoreRequest(JSON.stringify(input))).toThrow();
    expect(() => parseLegacyRecoveryStoreRequest(' '.repeat(65 * 1024))).toThrow('budget');
  });
  it('binds exact inventory bytes including the newline and refuses DENY and changed source binding', () => {
    const { request, output, bytes } = fixture();
    expect(verifyLegacyRecoveryInventory(request, bytes).decision).toBe('READY_TO_INSTALL');
    expect(() => verifyLegacyRecoveryInventory(request, bytes.subarray(0, -1))).toThrow('binding');
    for (const bad of [
      { ...output, decision: 'DENY' },
      { ...output, previewSha256: undefined },
      { ...output, previewSha256: sha('different preview') },
      { ...output, issues: [{ code: 'unknown', descriptor: 'scope' }] },
      { ...output, binding: { ...output.binding, queueFenceNonce: 'changed-nonce-12345' } },
      { ...output, selectedOwners: [] },
    ]) {
      const changed = Buffer.from(JSON.stringify(bad));
      expect(() =>
        verifyLegacyRecoveryInventory(
          {
            ...request,
            expected: { ...request.expected, inventoryArtifactSha256: sha(changed.toString()) },
          },
          changed,
        ),
      ).toThrow();
    }
  });
  it('requires a distinct read-only host client and a single bounded UTC pool', () => {
    const { request } = fixture();
    const env = {
      MAXIM_LEGACY_RECOVERY_OFFLINE: '1',
      MAXIM_LEGACY_RECOVERY_STORE_PROTOCOL: 'host-offline-v1',
      MAXIM_LEGACY_RECOVERY_STORE_MODE: 'readback',
      APP_SERVICE_NAME: 'legacy-recovery-store',
      APP_SOURCE_SHA: request.binding.sourceSha,
      MAXIM_LEGACY_RECOVERY_IMAGE_ID: request.binding.imageId,
      TZ: 'UTC',
    };
    expect(() => assertLegacyRecoveryStoreEnvironment(request, env)).not.toThrow();
    for (const key of Object.keys(env))
      expect(() => assertLegacyRecoveryStoreEnvironment(request, { ...env, [key]: '' })).toThrow();
    expect(() =>
      assertLegacyRecoveryStoreEnvironment({ ...request, operation: 'install' }, env),
    ).toThrow();
    expect(legacyRecoveryStorePoolConfig(true)).toMatchObject({
      max: 1,
      connectionTimeoutMillis: 1500,
      statement_timeout: 5000,
      options: expect.stringContaining('default_transaction_read_only=on'),
    });
  });
  it('bounds streamed stdin before parsing and refuses symlink or growing inventory files', async () => {
    expect(await readLegacyRecoveryStoreStdin(Readable.from(['{', '}']))).toBe('{}');
    await expect(
      readLegacyRecoveryStoreStdin(Readable.from([Buffer.alloc(65536), Buffer.from('x')])),
    ).rejects.toThrow('budget');
    const directory = await mkdtemp(join(tmpdir(), 'maxim-store-cli-'));
    try {
      const path = join(directory, 'inventory.json');
      await writeFile(path, '{}\n', { mode: 0o600 });
      expect(await readLegacyRecoveryInventoryFile(path)).toEqual(Buffer.from('{}\n'));
      await symlink(path, join(directory, 'link'));
      await expect(readLegacyRecoveryInventoryFile(join(directory, 'link'))).rejects.toThrow();
      await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
      await expect(readLegacyRecoveryInventoryFile(path)).rejects.toThrow('bounded');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
