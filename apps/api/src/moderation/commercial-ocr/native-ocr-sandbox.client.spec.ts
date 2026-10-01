import { chmod, link, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeOcrSandboxClient } from './native-ocr-sandbox.client';
import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  inspectNativeOcrSandboxDeclaredFrameBytes,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
  NATIVE_OCR_SANDBOX_HEADER_BYTES,
  NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES,
  NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
} from './native-ocr-sandbox.protocol';

describe('NativeOcrSandboxClient Unix transport', () => {
  it('round-trips a binary image after a client half-close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-socket-'));
    const socketPath = join(directory, 'ocr.sock');
    const source = Buffer.from([0, 255, 17, 9, 128]);
    const prepared = Buffer.from([137, 80, 78, 71]);
    let receivedPayload: Buffer | null = null;
    const client = new NativeOcrSandboxClient({
      get: (key) => (key === 'COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH' ? socketPath : undefined),
    });
    const fingerprint = (client as unknown as { expectedFingerprintSha256: string })
      .expectedFingerprintSha256;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      let length = 0;
      let declaredLength: number | null = null;
      let responded = false;
      socket.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
        length += chunk.byteLength;
        if (declaredLength === null && length >= NATIVE_OCR_SANDBOX_HEADER_BYTES) {
          declaredLength = inspectNativeOcrSandboxDeclaredFrameBytes(
            Buffer.concat(chunks, length).subarray(0, NATIVE_OCR_SANDBOX_HEADER_BYTES),
          );
        }
        if (responded || declaredLength === null || length !== declaredLength) return;
        responded = true;
        const request = decodeNativeOcrSandboxFrame(Buffer.concat(chunks, length), {
          metadataBytes: NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
          payloadBytes: NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES,
        });
        receivedPayload = Buffer.from(request.payload);
        socket.end(
          encodeNativeOcrSandboxFrame({
            kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
            metadata: {
              status: 'ok',
              width: 1,
              height: 1,
              fingerprintSha256: fingerprint,
              boundary: {
                transport: 'unix_socket',
                network: 'none',
                environment: 'allowlist',
                processGroupTeardown: 'verified_or_cgroup_recycle',
                instanceId: '00000000-0000-4000-8000-000000000001',
              },
            },
            payload: prepared,
            limits: { metadataBytes: 4 * 1024 * 1024, payloadBytes: 64 * 1024 * 1024 },
          }),
        );
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      await expect(client.preprocess(source, 'primary', 1_000)).resolves.toEqual({
        bytes: prepared,
        width: 1,
        height: 1,
      });
      expect(receivedPayload).toEqual(source);
      expect(client.isVerified()).toBe(true);
      const verifiedAt = (client as unknown as { verifiedAtMs: number }).verifiedAtMs;
      const now = jest.spyOn(Date, 'now').mockReturnValue(verifiedAt - 1);
      expect(client.isVerified()).toBe(false);
      now.mockReturnValue(verifiedAt + 15_001);
      expect(client.isVerified()).toBe(false);
      now.mockRestore();
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a genuinely missing socket retryable and clears its previously verified boundary', async () => {
    await withSandboxTransport(async ({ client, socketPath, connections }) => {
      await expect(client.preprocess(Buffer.from([1]), 'primary', 1_000)).resolves.toBeDefined();
      expect(client.isVerified()).toBe(true);
      await unlink(socketPath);

      await expect(client.preprocess(Buffer.from([1]), 'primary', 1_000)).rejects.toMatchObject({
        reason: 'unavailable',
      });
      expect(connections()).toBe(1);
      expectBoundaryCleared(client);
    });
  });

  it('keeps a real transport timeout retryable and closes its request without retaining verification', async () => {
    await withSandboxTransport(async ({ client, setResponse, connections }) => {
      await expect(client.preprocess(Buffer.from([1]), 'primary', 1_000)).resolves.toBeDefined();
      expect(client.isVerified()).toBe(true);
      setResponse(null);

      await expect(client.preprocess(Buffer.from([1]), 'primary', 1)).rejects.toMatchObject({
        reason: 'unavailable',
      });
      expect(connections()).toBe(2);
      expectBoundaryCleared(client);
    });
  });

  it.each(['mode', 'owner', 'link-count', 'file-type'] as const)(
    'rejects a present socket with an invalid %s boundary before connecting',
    async (invalidBoundary) => {
      await withSandboxTransport(async ({ client, socketPath, connections }) => {
        await expect(client.preprocess(Buffer.from([1]), 'primary', 1_000)).resolves.toBeDefined();
        expect(client.isVerified()).toBe(true);
        const currentUserId = process.getuid!();
        let ownerSpy: jest.SpyInstance | undefined;
        try {
          if (invalidBoundary === 'mode') {
            await chmod(socketPath, 0o660);
          } else if (invalidBoundary === 'owner') {
            ownerSpy = jest.spyOn(process, 'getuid').mockReturnValue(currentUserId + 1);
          } else if (invalidBoundary === 'link-count') {
            await link(socketPath, `${socketPath}.alias`);
          } else {
            await unlink(socketPath);
            await writeFile(socketPath, Buffer.from([1]), { mode: 0o600 });
          }

          await expect(client.preprocess(Buffer.from([1]), 'primary', 1_000)).rejects.toMatchObject(
            {
              reason: 'unverified',
            },
          );
          expect(connections()).toBe(1);
          expectBoundaryCleared(client);
        } finally {
          ownerSpy?.mockRestore();
        }
      });
    },
  );

  it.each([
    ['malformed JSON', '{"'],
    ['non-object metadata', '[]'],
  ])(
    'rejects %s as an invalid response and clears a previously verified boundary',
    async (_name, metadata) => {
      await withSandboxTransport(async ({ client, setResponse, connections }) => {
        await expect(client.preprocess(Buffer.from([1]), 'primary', 1_000)).resolves.toBeDefined();
        expect(client.isVerified()).toBe(true);
        const frame = encodeNativeOcrSandboxFrame({
          kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
          metadata: {},
          payload: Buffer.from([1]),
          limits: { metadataBytes: 4 * 1024, payloadBytes: 1 },
        });
        Buffer.from(metadata).copy(frame, NATIVE_OCR_SANDBOX_HEADER_BYTES);
        setResponse(frame);

        await expect(client.preprocess(Buffer.from([1]), 'primary', 1_000)).rejects.toMatchObject({
          reason: 'invalid_response',
        });
        expect(connections()).toBe(2);
        expectBoundaryCleared(client);
      });
    },
  );
});

function expectBoundaryCleared(client: NativeOcrSandboxClient): void {
  expect(client.getStatus()).toMatchObject({ verified: false, activeRequests: 0 });
  expect((client as unknown as { verifiedAtMs: number }).verifiedAtMs).toBe(0);
}

async function withSandboxTransport(
  run: (fixture: {
    client: NativeOcrSandboxClient;
    socketPath: string;
    setResponse: (response: Buffer | null) => void;
    connections: () => number;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-boundary-'));
  const socketPath = join(directory, 'ocr.sock');
  const client = new NativeOcrSandboxClient({
    get: (key) => (key === 'COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH' ? socketPath : undefined),
  });
  const fingerprint = (client as unknown as { expectedFingerprintSha256: string })
    .expectedFingerprintSha256;
  let response: Buffer | null = encodeNativeOcrSandboxFrame({
    kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
    metadata: {
      status: 'ok',
      width: 1,
      height: 1,
      fingerprintSha256: fingerprint,
      boundary: {
        transport: 'unix_socket',
        network: 'none',
        environment: 'allowlist',
        processGroupTeardown: 'verified_or_cgroup_recycle',
        instanceId: '00000000-0000-4000-8000-000000000001',
      },
    },
    payload: Buffer.from([1]),
    limits: { metadataBytes: 4 * 1024, payloadBytes: 1 },
  });
  let connectionCount = 0;
  const serverSockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connectionCount += 1;
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
    socket.on('error', () => undefined);
    const chunks: Buffer[] = [];
    let length = 0;
    let declaredLength: number | null = null;
    socket.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      length += chunk.byteLength;
      if (declaredLength === null && length >= NATIVE_OCR_SANDBOX_HEADER_BYTES) {
        declaredLength = inspectNativeOcrSandboxDeclaredFrameBytes(
          Buffer.concat(chunks, length).subarray(0, NATIVE_OCR_SANDBOX_HEADER_BYTES),
        );
      }
      if (declaredLength !== null && length === declaredLength && response !== null) {
        socket.end(response);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await run({
      client,
      socketPath,
      setResponse: (next) => {
        response = next;
      },
      connections: () => connectionCount,
    });
  } finally {
    client.close();
    for (const socket of serverSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
