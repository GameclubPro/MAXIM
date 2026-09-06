import { chmod, lstat, unlink } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';

import {
  resolveCommercialOcrNativeEngineConfig,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionNativeConfigReader,
  resolveExpectedCommercialOcrProductionBehaviorIdentity,
  resolveVerifiedCommercialOcrNativeBehaviorIdentity,
  type CommercialOcrNativeBehaviorIdentity,
  type CommercialOcrNativeArtifactVerification,
} from './commercial-ocr-behavior-identity';
import { restrictNativeOcrSandboxEnvironment } from './native-ocr-sandbox.environment';
import {
  CommercialOcrImageRejectedError,
  resolveCommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocess-config';
import type { NativeOcrImagePreprocessor } from './native-ocr-image-preprocessor';
import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  inspectNativeOcrSandboxDeclaredFrameBytes,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
  NATIVE_OCR_SANDBOX_HEADER_BYTES,
  NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES,
  NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES,
  NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
  NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES,
  NATIVE_OCR_SANDBOX_MAX_SOURCE_IMAGE_BYTES,
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  resolveNativeOcrSandboxSocketPath,
  type NativeOcrSandboxFrame,
  type NativeOcrSandboxFrameKind,
} from './native-ocr-sandbox.protocol';
import {
  nativeProcessGroupIsolationSupported,
  signalNativeProcessGroup,
  verifyNativeProcessGroupTeardown,
} from './native-process-group';
import { probeNativeTesseract, runNativeTesseract } from './native-tesseract-runner';

const SOCKET_MODE = 0o600;
const REQUEST_RECEIVE_TIMEOUT_MS = 5_000;
const NATIVE_CONTAINMENT_GRACE_MS = 500;
const MAX_CONNECTIONS = 5;

const BOUNDARY_ATTESTATION = Object.freeze({
  transport: 'unix_socket',
  network: 'none',
  environment: 'allowlist',
  processGroupTeardown: 'verified_or_cgroup_recycle',
  instanceId: randomUUID(),
} as const);

type PendingRequest = {
  socket: Socket;
  frame: NativeOcrSandboxFrame;
};

export type NativeOcrSandboxServer = Readonly<{
  close: () => Promise<void>;
  socketPath: string;
}>;

export type NativeOcrSandboxServerDependencies = Readonly<{
  networkInterfaces: typeof networkInterfaces;
  verifyNativeIdentity: (
    config: Readonly<{ get(propertyPath: string): unknown }>,
    expected: CommercialOcrNativeBehaviorIdentity,
  ) => Promise<CommercialOcrNativeArtifactVerification>;
  probeNativeTesseract: typeof probeNativeTesseract;
  runNativeTesseract: typeof runNativeTesseract;
  createPreprocessor: (
    config: Readonly<{ get(propertyPath: string): unknown }>,
  ) => Promise<Pick<NativeOcrImagePreprocessor, 'prepare'>>;
  signalNativeProcessGroup: typeof signalNativeProcessGroup;
  verifyNativeProcessGroupTeardown: typeof verifyNativeProcessGroupTeardown;
  fatalExit: () => void;
  allowTestSocketPath: boolean;
}>;

export async function startNativeOcrSandboxServer(
  environment: NodeJS.ProcessEnv = process.env,
  dependencyOverrides: Partial<NativeOcrSandboxServerDependencies> = {},
): Promise<NativeOcrSandboxServer> {
  const dependencies = resolveServerDependencies(dependencyOverrides);
  // FLAG: Normalize and verify isolation before loading Sharp or spawning Tesseract.
  restrictNativeOcrSandboxEnvironment(environment);
  if (!nativeProcessGroupIsolationSupported()) {
    throw new Error('Native OCR sandbox requires POSIX process-group isolation');
  }
  assertNativeOcrSandboxNetworkIsolated(dependencies.networkInterfaces());
  const config = environmentConfigReader(environment);
  const productionConfig = resolveCommercialOcrProductionNativeConfigReader(config);
  const socketPath = resolveNativeOcrSandboxSocketPath(
    environment[NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV],
    { requireRuntimeDirectory: !dependencies.allowTestSocketPath },
  );
  if (!socketPath) {
    throw new Error(`${NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV} is required`);
  }
  const controls = resolveCommercialOcrNativeRuntimeControls(productionConfig);
  if (controls.concurrency !== 1 || controls.ompThreadLimit !== 1) {
    throw new Error('Native OCR sandbox production concurrency must remain one');
  }
  const expected =
    resolveExpectedCommercialOcrProductionBehaviorIdentity(productionConfig).identity;
  const verification = await dependencies.verifyNativeIdentity(productionConfig, expected);
  if (
    !verification.verified ||
    !verification.identity.complete ||
    verification.identity.fingerprintSha256 !== expected.fingerprintSha256
  ) {
    throw new Error('Native OCR sandbox artifact identity verification failed');
  }
  const engine = resolveCommercialOcrNativeEngineConfig(productionConfig);
  let containmentFailed = false;
  const languageProbe = await dependencies.probeNativeTesseract({
    binary: engine.binary,
    ...(engine.tessdataPrefix ? { tessdataPrefix: engine.tessdataPrefix } : {}),
    timeoutMs: 4_000,
    maxOutputBytes: 64 * 1024,
    requireProcessGroupTeardown: true,
    onProcessGroupTeardownFailure: () => {
      containmentFailed = true;
    },
  });
  if (!languageProbe.ok || containmentFailed) {
    throw new Error('Native OCR sandbox language or process-group probe failed');
  }

  await assertOwnedSocketDirectory(socketPath);
  await removeOwnedStaleSocket(socketPath);
  const preprocessor = await dependencies.createPreprocessor(productionConfig);
  const pending: PendingRequest[] = [];
  const openSockets = new Set<Socket>();
  let pendingBytes = 0;
  let active = false;
  let activeSocket: Socket | null = null;
  let activeRequestKind: 'preprocess' | 'recognize' | null = null;
  let activeRequest: Promise<void> | null = null;
  let activeNativeProcess: ChildProcessWithoutNullStreams | null = null;
  let shuttingDown = false;
  let fatalTimer: NodeJS.Timeout | null = null;
  const maximumPendingBytes = Math.min(
    NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES * controls.maxQueue,
    Math.max(controls.maxSourceImageBytes, controls.maxImageBytes) * controls.maxQueue,
  );

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (shuttingDown || openSockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    openSockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      openSockets.delete(socket);
      const pendingIndex = pending.findIndex((request) => request.socket === socket);
      if (pendingIndex >= 0) {
        const [abandoned] = pending.splice(pendingIndex, 1);
        if (abandoned) {
          pendingBytes -= abandoned.frame.payload.byteLength;
          abandoned.frame.payload.fill(0);
        }
      }
      if (!shuttingDown && activeSocket === socket) {
        if (activeRequestKind === 'preprocess') {
          // Sharp has no reliable per-operation cancellation boundary. Recycle its cgroup.
          fatalContainmentFailure();
          return;
        }
        if (activeNativeProcess) {
          dependencies.signalNativeProcessGroup(activeNativeProcess, 'SIGKILL', {
            requireIsolatedGroup: true,
          });
          // A forced native cancellation must also cover descendants that escaped the PGID.
          fatalContainmentFailure();
        }
      }
    });
    void readRequest(socket, Math.max(controls.maxSourceImageBytes, controls.maxImageBytes))
      .then((frame) => {
        if (frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest) {
          if (frame.payload.byteLength !== 0 || !hasExactKeys(frame.metadata, [])) {
            frame.payload.fill(0);
            socket.destroy();
            return;
          }
          respondProbe(socket, verification.identity);
          return;
        }
        if (
          shuttingDown ||
          pending.length >= controls.maxQueue ||
          pendingBytes + frame.payload.byteLength > maximumPendingBytes
        ) {
          respondFailure(
            socket,
            responseKindForRequest(frame.kind),
            expected,
            'capacity_exhausted',
          );
          frame.payload.fill(0);
          return;
        }
        pending.push({ socket, frame });
        pendingBytes += frame.payload.byteLength;
        drain();
      })
      .catch(() => socket.destroy());
  });
  server.maxConnections = MAX_CONNECTIONS;

  const fatalContainmentFailure = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = 1;
    server.close();
    for (const request of pending.splice(0)) {
      request.frame.payload.fill(0);
      request.socket.destroy();
    }
    pendingBytes = 0;
    for (const socket of openSockets) socket.destroy();
    fatalTimer = setTimeout(dependencies.fatalExit, 0);
  };

  const processRequest = async (request: PendingRequest): Promise<void> => {
    const { frame, socket } = request;
    try {
      if (socket.destroyed) return;
      if (frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest) {
        const input = validatePreprocessRequest(frame, controls.maxSourceImageBytes);
        const hardDeadline = setTimeout(
          fatalContainmentFailure,
          input.timeoutMs + NATIVE_CONTAINMENT_GRACE_MS,
        );
        try {
          const result = await preprocessor.prepare(frame.payload, input.pass, {
            deadlineAtMs: Date.now() + input.timeoutMs,
          });
          respond(
            socket,
            NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
            expected,
            {
              status: 'ok',
              width: result.width,
              height: result.height,
            },
            result.bytes,
            controls.maxImageBytes,
          );
          result.bytes.fill(0);
        } catch (error: unknown) {
          const reason =
            error instanceof CommercialOcrImageRejectedError ? error.reason : 'processing_timeout';
          respondFailure(
            socket,
            NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
            expected,
            reason,
          );
          if (reason === 'processing_timeout') {
            fatalContainmentFailure();
          }
        } finally {
          clearTimeout(hardDeadline);
        }
        return;
      }

      const input = validateRecognizeRequest(frame, controls.maxImageBytes, controls.timeoutMs);
      if (socket.destroyed) return;
      let processGroupTeardownFailed = false;
      let requestNativeProcess: ChildProcessWithoutNullStreams | null = null;
      const result = await dependencies.runNativeTesseract({
        binary: engine.binary,
        ...(engine.tessdataPrefix ? { tessdataPrefix: engine.tessdataPrefix } : {}),
        image: frame.payload,
        psm: input.psm,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: controls.maxOutputBytes,
        ompThreadLimit: controls.ompThreadLimit,
        requireProcessGroupTeardown: true,
        onProcessGroupTeardownFailure: () => {
          processGroupTeardownFailed = true;
        },
        onProcessChange: (child) => {
          if (child) {
            requestNativeProcess = child;
            activeNativeProcess = child;
            if (socket.destroyed) {
              dependencies.signalNativeProcessGroup(child, 'SIGKILL', {
                requireIsolatedGroup: true,
              });
              fatalContainmentFailure();
            }
          } else if (activeNativeProcess === requestNativeProcess) {
            activeNativeProcess = null;
          }
        },
      });
      if (processGroupTeardownFailed) {
        socket.destroy();
        fatalContainmentFailure();
        return;
      }
      respond(
        socket,
        NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeResponse,
        expected,
        { status: 'ok', result },
        Buffer.alloc(0),
        0,
      );
      if (!result.ok && (result.reason === 'timeout' || result.reason === 'output_limit')) {
        fatalContainmentFailure();
      }
    } catch {
      respondFailure(socket, responseKindForRequest(frame.kind), expected, 'invalid_input');
    } finally {
      frame.payload.fill(0);
    }
  };

  function drain(): void {
    if (active || shuttingDown) return;
    let request = pending.shift();
    while (request?.socket.destroyed) {
      pendingBytes -= request.frame.payload.byteLength;
      request.frame.payload.fill(0);
      request = pending.shift();
    }
    if (!request) return;
    pendingBytes -= request.frame.payload.byteLength;
    active = true;
    activeSocket = request.socket;
    activeRequestKind =
      request.frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest
        ? 'preprocess'
        : 'recognize';
    const operation = processRequest(request).finally(() => {
      active = false;
      if (activeSocket === request.socket) {
        activeSocket = null;
        activeRequestKind = null;
      }
      if (activeRequest === operation) activeRequest = null;
      drain();
    });
    activeRequest = operation;
    void operation;
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  try {
    await chmod(socketPath, SOCKET_MODE);
  } catch (error: unknown) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeOwnedStaleSocket(socketPath).catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    socketPath,
    close: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (fatalTimer) clearTimeout(fatalTimer);
      for (const request of pending.splice(0)) {
        request.frame.payload.fill(0);
        request.socket.destroy();
      }
      pendingBytes = 0;
      if (activeNativeProcess) {
        const nativeProcess = activeNativeProcess;
        if (
          !dependencies.signalNativeProcessGroup(nativeProcess, 'SIGKILL', {
            requireIsolatedGroup: true,
          }) ||
          !(await dependencies.verifyNativeProcessGroupTeardown(nativeProcess, {
            graceMs: NATIVE_CONTAINMENT_GRACE_MS,
            requireIsolatedGroup: true,
          }))
        ) {
          throw new Error('Native OCR sandbox could not verify process-group teardown');
        }
      }
      activeSocket = null;
      for (const socket of openSockets) socket.destroy();
      if (activeRequest) {
        await waitBounded(activeRequest, NATIVE_CONTAINMENT_GRACE_MS);
      }
      await waitBounded(
        new Promise<void>((resolve) => server.close(() => resolve())),
        NATIVE_CONTAINMENT_GRACE_MS,
      );
      await removeOwnedStaleSocket(socketPath);
    },
  });
}

export function assertNativeOcrSandboxNetworkIsolated(
  interfaces: ReturnType<typeof networkInterfaces>,
): void {
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (!address.internal || (name !== 'lo' && name !== 'lo0')) {
        throw new Error('Native OCR sandbox has a non-loopback network interface');
      }
    }
  }
}

async function readRequest(
  socket: Socket,
  maximumPayloadBytes: number,
): Promise<NativeOcrSandboxFrame> {
  const bytes = await readSingleFrame(
    socket,
    REQUEST_RECEIVE_TIMEOUT_MS,
    Math.min(
      NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES,
      NATIVE_OCR_SANDBOX_HEADER_BYTES +
        NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES +
        maximumPayloadBytes,
    ),
  );
  const frame = decodeNativeOcrSandboxFrame(bytes, {
    metadataBytes: NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
    payloadBytes: maximumPayloadBytes,
  });
  if (
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest &&
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest &&
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest
  ) {
    throw new Error('Native OCR sandbox received a response frame');
  }
  socket.once('data', () => socket.destroy());
  socket.once('end', () => socket.destroy());
  socket.resume();
  return frame;
}

function readSingleFrame(socket: Socket, timeoutMs: number, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let declaredBytes: number | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks, receivedBytes));
      }
    };
    const onData = (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maximumBytes) {
        finish(new Error('Native OCR sandbox request exceeds its byte limit'));
        socket.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
      if (declaredBytes === null && receivedBytes >= NATIVE_OCR_SANDBOX_HEADER_BYTES) {
        try {
          declaredBytes = inspectNativeOcrSandboxDeclaredFrameBytes(
            Buffer.concat(chunks, receivedBytes).subarray(0, NATIVE_OCR_SANDBOX_HEADER_BYTES),
          );
          if (declaredBytes > maximumBytes) {
            throw new Error('Native OCR sandbox declared frame exceeds its byte limit');
          }
        } catch (error: unknown) {
          finish(error instanceof Error ? error : new Error('Native OCR sandbox frame is invalid'));
          socket.destroy();
        }
      }
      if (declaredBytes !== null) {
        if (receivedBytes > declaredBytes) {
          finish(new Error('Native OCR sandbox request has trailing bytes'));
          socket.destroy();
        } else if (receivedBytes === declaredBytes) {
          socket.pause();
          finish();
        }
      }
    };
    const onEnd = () => {
      finish(new Error('Native OCR sandbox request frame is truncated'));
    };
    const onError = () => finish(new Error('Native OCR sandbox request socket failed'));
    const timeout = setTimeout(() => {
      finish(new Error('Native OCR sandbox request timed out'));
      socket.destroy();
    }, timeoutMs);
    timeout.unref();
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

function respondProbe(socket: Socket, identity: CommercialOcrNativeBehaviorIdentity): void {
  respond(
    socket,
    NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse,
    identity,
    {
      status: 'ok',
      identity: { fingerprintSha256: identity.fingerprintSha256, manifest: identity.manifest },
    },
    Buffer.alloc(0),
    0,
  );
}

function respondFailure(
  socket: Socket,
  kind: NativeOcrSandboxFrameKind,
  identity: CommercialOcrNativeBehaviorIdentity,
  reason: string,
): void {
  const metadata =
    kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeResponse
      ? { status: 'error', reason, result: { ok: false, reason: 'tesseract_failed' } }
      : { status: 'error', reason };
  respond(socket, kind, identity, metadata, Buffer.alloc(0), 0);
}

function respond(
  socket: Socket,
  kind: NativeOcrSandboxFrameKind,
  identity: CommercialOcrNativeBehaviorIdentity,
  metadata: Readonly<Record<string, unknown>>,
  payload: Buffer,
  maximumPayloadBytes: number,
): void {
  try {
    const frame = encodeNativeOcrSandboxFrame({
      kind,
      metadata: {
        ...metadata,
        fingerprintSha256: identity.fingerprintSha256,
        boundary: BOUNDARY_ATTESTATION,
      },
      payload,
      limits: {
        metadataBytes: NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES,
        payloadBytes: maximumPayloadBytes,
      },
    });
    socket.once('finish', () => frame.fill(0));
    socket.once('close', () => frame.fill(0));
    socket.end(frame);
  } catch {
    socket.destroy();
  }
}

function validatePreprocessRequest(
  frame: NativeOcrSandboxFrame,
  maximumImageBytes: number,
): { pass: 'primary' | 'confirmation'; timeoutMs: number } {
  if (
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest ||
    frame.payload.byteLength < 1 ||
    frame.payload.byteLength >
      Math.min(maximumImageBytes, NATIVE_OCR_SANDBOX_MAX_SOURCE_IMAGE_BYTES) ||
    (frame.metadata.pass !== 'primary' && frame.metadata.pass !== 'confirmation') ||
    !isIntegerBetween(frame.metadata.timeoutMs, 1, 5_000) ||
    !hasExactKeys(frame.metadata, ['pass', 'timeoutMs'])
  ) {
    throw new Error('Native OCR sandbox preprocess request is invalid');
  }
  return {
    pass: frame.metadata.pass,
    timeoutMs: frame.metadata.timeoutMs as number,
  };
}

function validateRecognizeRequest(
  frame: NativeOcrSandboxFrame,
  maximumImageBytes: number,
  maximumTimeoutMs: number,
): { psm: 6 | 11; timeoutMs: number } {
  if (
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest ||
    frame.payload.byteLength < 1 ||
    frame.payload.byteLength >
      Math.min(maximumImageBytes, NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES) ||
    (frame.metadata.psm !== 6 && frame.metadata.psm !== 11) ||
    !isIntegerBetween(frame.metadata.timeoutMs, 1, maximumTimeoutMs) ||
    !hasExactKeys(frame.metadata, ['psm', 'timeoutMs'])
  ) {
    throw new Error('Native OCR sandbox recognition request is invalid');
  }
  return { psm: frame.metadata.psm, timeoutMs: frame.metadata.timeoutMs as number };
}

function responseKindForRequest(kind: NativeOcrSandboxFrameKind): NativeOcrSandboxFrameKind {
  if (kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest) {
    return NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse;
  }
  if (kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest) {
    return NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeResponse;
  }
  return NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse;
}

function environmentConfigReader(environment: NodeJS.ProcessEnv) {
  return Object.freeze({ get: (propertyPath: string): unknown => environment[propertyPath] });
}

function resolveServerDependencies(
  overrides: Partial<NativeOcrSandboxServerDependencies>,
): NativeOcrSandboxServerDependencies {
  return Object.freeze({
    networkInterfaces: overrides.networkInterfaces ?? networkInterfaces,
    verifyNativeIdentity:
      overrides.verifyNativeIdentity ??
      ((config) => resolveVerifiedCommercialOcrNativeBehaviorIdentity(config)),
    probeNativeTesseract: overrides.probeNativeTesseract ?? probeNativeTesseract,
    runNativeTesseract: overrides.runNativeTesseract ?? runNativeTesseract,
    createPreprocessor:
      overrides.createPreprocessor ??
      (async (config) => {
        const { NativeOcrImagePreprocessor } = await import('./native-ocr-image-preprocessor');
        return new NativeOcrImagePreprocessor(resolveCommercialOcrPreprocessLimits(config));
      }),
    signalNativeProcessGroup: overrides.signalNativeProcessGroup ?? signalNativeProcessGroup,
    verifyNativeProcessGroupTeardown:
      overrides.verifyNativeProcessGroupTeardown ?? verifyNativeProcessGroupTeardown,
    fatalExit: overrides.fatalExit ?? (() => process.exit(1)),
    allowTestSocketPath: overrides.allowTestSocketPath ?? false,
  });
}

async function removeOwnedStaleSocket(socketPath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(socketPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.nlink !== 1) {
    throw new Error('Native OCR sandbox socket path is occupied by an unsafe entry');
  }
  await unlink(socketPath);
}

async function assertOwnedSocketDirectory(socketPath: string): Promise<void> {
  const directory = await lstat(dirname(socketPath));
  const currentUserId = process.getuid?.();
  if (
    !directory.isDirectory() ||
    currentUserId === undefined ||
    directory.uid !== currentUserId ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error('Native OCR sandbox socket directory is unsafe');
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

async function waitBounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Native OCR sandbox shutdown timed out')),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
