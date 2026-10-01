import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';

import { assertNativeOcrSandboxSharedClock } from './native-ocr-sandbox.clock';

import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  inspectNativeOcrSandboxDeclaredFrameBytes,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
  NATIVE_OCR_SANDBOX_HEADER_BYTES,
  NATIVE_OCR_SANDBOX_PROTOCOL_VERSION,
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  resolveNativeOcrSandboxSocketPath,
  type NativeOcrSandboxFrame,
} from './native-ocr-sandbox.protocol';

export const NATIVE_OCR_SANDBOX_PROBE_EXPECTATION_PATH =
  '/app/apps/api/commercial-ocr-native-probe-expectation.json';
const EXPECTATION_KIND = 'commercial_ocr_native_probe_expectation';
const EXPECTATION_SCHEMA_VERSION = 1;
const MAX_EXPECTATION_BYTES = 4 * 1024;
const MAX_PROBE_METADATA_BYTES = 64 * 1024;
const MAX_PROBE_FRAME_BYTES = NATIVE_OCR_SANDBOX_HEADER_BYTES + MAX_PROBE_METADATA_BYTES;
const PROBE_TIMEOUT_MS = 6_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUIRED_BOUNDARY = Object.freeze({
  transport: 'unix_socket',
  network: 'none',
  environment: 'allowlist',
  processGroupTeardown: 'verified_or_cgroup_recycle',
});

export function serializeNativeOcrSandboxProbeExpectation(fingerprintSha256: string): string {
  if (!SHA256_PATTERN.test(fingerprintSha256)) {
    throw new Error('Native OCR sandbox probe expectation is invalid');
  }
  return `${JSON.stringify({
    kind: EXPECTATION_KIND,
    schemaVersion: EXPECTATION_SCHEMA_VERSION,
    protocolVersion: NATIVE_OCR_SANDBOX_PROTOCOL_VERSION,
    fingerprintSha256,
  })}\n`;
}

export async function runNativeOcrSandboxReadinessProbe(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  const socketPath = resolveNativeOcrSandboxSocketPath(
    environment[NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV],
    {
      requireRuntimeDirectory: true,
    },
  );
  if (!socketPath) throw new Error('Native OCR sandbox probe socket is unconfigured');
  await probeNativeOcrSandboxReadiness({ socketPath });
}

export async function probeNativeOcrSandboxReadiness(params: {
  socketPath: string;
  expectationPath?: string;
  timeoutMs?: number;
}): Promise<void> {
  const socketPath = resolveNativeOcrSandboxSocketPath(params.socketPath);
  const timeoutMs = params.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (
    !socketPath ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PROBE_TIMEOUT_MS
  ) {
    throw new Error('Native OCR sandbox probe configuration is invalid');
  }
  const deadlineAtMs = performance.now() + timeoutMs;
  assertNativeOcrSandboxSharedClock();
  const fingerprint = readExpectedFingerprint(
    params.expectationPath ?? NATIVE_OCR_SANDBOX_PROBE_EXPECTATION_PATH,
  );
  const userId = process.getuid?.();
  if (userId === undefined) throw new Error('Native OCR sandbox probe requires Unix ownership');
  const directoryPath = socketPath.slice(0, socketPath.lastIndexOf('/')) || '/';
  const directory = await bounded(lstat(directoryPath), deadlineAtMs);
  const socket = await bounded(lstat(socketPath), deadlineAtMs);
  if (
    !directory.isDirectory() ||
    directory.uid !== userId ||
    (directory.mode & 0o777) !== 0o700 ||
    !socket.isSocket() ||
    socket.uid !== userId ||
    socket.nlink !== 1 ||
    (socket.mode & 0o777) !== 0o600
  ) {
    throw new Error('Native OCR sandbox probe socket boundary is invalid');
  }
  const response = await requestProbe(socketPath, deadlineAtMs);
  requireExactProbeIdentity(response, fingerprint);
  const currentSocket = await bounded(lstat(socketPath), deadlineAtMs);
  if (
    !currentSocket.isSocket() ||
    currentSocket.uid !== userId ||
    currentSocket.nlink !== 1 ||
    (currentSocket.mode & 0o777) !== 0o600 ||
    currentSocket.ino !== socket.ino ||
    currentSocket.dev !== socket.dev
  ) {
    throw new Error('Native OCR sandbox probe socket changed');
  }
  if (performance.now() >= deadlineAtMs) throw new Error('Native OCR sandbox probe timed out');
}

function readExpectedFingerprint(pathname: string): string {
  // FLAG: Trust comes from the immutable root-owned image artifact, never the live response or env.
  const descriptor = openSync(
    pathname,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o444 ||
      stat.size < 1 ||
      stat.size > MAX_EXPECTATION_BYTES
    ) {
      throw new Error('Native OCR sandbox probe expectation boundary is invalid');
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== stat.size || bytes.byteLength > MAX_EXPECTATION_BYTES) {
      throw new Error('Native OCR sandbox probe expectation size is invalid');
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 4 ||
      value.kind !== EXPECTATION_KIND ||
      value.schemaVersion !== EXPECTATION_SCHEMA_VERSION ||
      value.protocolVersion !== NATIVE_OCR_SANDBOX_PROTOCOL_VERSION ||
      typeof value.fingerprintSha256 !== 'string' ||
      !SHA256_PATTERN.test(value.fingerprintSha256) ||
      bytes.toString('utf8') !== serializeNativeOcrSandboxProbeExpectation(value.fingerprintSha256)
    ) {
      throw new Error('Native OCR sandbox probe expectation is invalid');
    }
    return value.fingerprintSha256;
  } finally {
    closeSync(descriptor);
  }
}

function requireExactProbeIdentity(
  frame: NativeOcrSandboxFrame,
  expectedFingerprint: string,
): void {
  const { metadata } = frame;
  const boundary = metadata.boundary;
  const identity = metadata.identity;
  if (
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse ||
    frame.payload.byteLength !== 0 ||
    metadata.status !== 'ok' ||
    metadata.fingerprintSha256 !== expectedFingerprint ||
    !isRecord(boundary) ||
    !Object.entries(REQUIRED_BOUNDARY).every(([key, value]) => boundary[key] === value) ||
    typeof boundary.instanceId !== 'string' ||
    !UUID_PATTERN.test(boundary.instanceId) ||
    !isRecord(identity) ||
    Object.keys(identity).length !== 2 ||
    identity.fingerprintSha256 !== expectedFingerprint ||
    !isRecord(identity.manifest)
  ) {
    throw new Error('Native OCR sandbox probe identity is unverified');
  }
  // FLAG: Recompute the complete manifest hash against a build-time literal; echoed hashes alone are insufficient.
  const actualFingerprint = createHash('sha256')
    .update(canonicalJson(identity.manifest))
    .digest('hex');
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error('Native OCR sandbox probe manifest is unverified');
  }
}

function requestProbe(socketPath: string, deadlineAtMs: number): Promise<NativeOcrSandboxFrame> {
  const request = encodeNativeOcrSandboxFrame({
    kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest,
    metadata: {},
    limits: { metadataBytes: 4 * 1024, payloadBytes: 0 },
  });
  return new Promise((resolve, reject) => {
    const remainingMs = Math.floor(deadlineAtMs - performance.now());
    if (remainingMs < 1) {
      reject(new Error('Native OCR sandbox probe timed out'));
      return;
    }
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let declaredBytes: number | null = null;
    let settled = false;
    const finish = (error?: Error, frame?: NativeOcrSandboxFrame): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      if (error || !frame)
        reject(error ?? new Error('Native OCR sandbox probe response is invalid'));
      else resolve(frame);
    };
    const timeout = setTimeout(
      () => finish(new Error('Native OCR sandbox probe timed out')),
      remainingMs,
    );
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      try {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_PROBE_FRAME_BYTES)
          throw new Error('Native OCR sandbox probe response is oversized');
        chunks.push(Buffer.from(chunk));
        if (declaredBytes === null && receivedBytes >= NATIVE_OCR_SANDBOX_HEADER_BYTES) {
          const header = Buffer.concat(chunks, receivedBytes).subarray(
            0,
            NATIVE_OCR_SANDBOX_HEADER_BYTES,
          );
          declaredBytes = inspectNativeOcrSandboxDeclaredFrameBytes(header);
          if (
            header.readUInt8(5) !== NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse ||
            header.readUInt32BE(12) !== 0 ||
            declaredBytes > MAX_PROBE_FRAME_BYTES
          )
            throw new Error('Native OCR sandbox probe response header is invalid');
        }
        if (declaredBytes !== null && receivedBytes > declaredBytes) {
          throw new Error('Native OCR sandbox probe response contains extra data');
        }
      } catch {
        finish(new Error('Native OCR sandbox probe response is invalid'));
      }
    });
    // FLAG: Wait for EOF so a complete first frame cannot hide trailing bytes in a later packet.
    socket.once('end', () => {
      try {
        const frame = decodeNativeOcrSandboxFrame(Buffer.concat(chunks, receivedBytes), {
          metadataBytes: MAX_PROBE_METADATA_BYTES,
          payloadBytes: 0,
          frameBytes: MAX_PROBE_FRAME_BYTES,
        });
        finish(undefined, frame);
      } catch {
        finish(new Error('Native OCR sandbox probe response is invalid'));
      }
    });
    socket.once('error', () =>
      finish(new Error('Native OCR sandbox probe transport is unavailable')),
    );
    socket.once('close', () => {
      if (!settled) finish(new Error('Native OCR sandbox probe response ended early'));
    });
  });
}

function bounded<T>(operation: Promise<T>, deadlineAtMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const remainingMs = Math.floor(deadlineAtMs - performance.now());
    if (remainingMs < 1) {
      void operation.catch(() => undefined);
      reject(new Error('Native OCR sandbox probe timed out'));
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error('Native OCR sandbox probe timed out')),
      remainingMs,
    );
    operation
      .then(resolve, () => reject(new Error('Native OCR sandbox probe filesystem is unavailable')))
      .finally(() => clearTimeout(timeout));
  });
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 16) throw new Error('Native OCR sandbox probe manifest is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`)
      .join(',')}}`;
  }
  throw new Error('Native OCR sandbox probe manifest contains an unsupported value');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
