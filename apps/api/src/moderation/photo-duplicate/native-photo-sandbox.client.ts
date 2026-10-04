import { createConnection } from 'node:net';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint-version';
import {
  PHOTO_NATIVE_MAX_EXECUTION_MS,
  PHOTO_NATIVE_PROTOCOL_VERSION,
  encodePhotoFrame,
  parsePhotoResult,
  type NativePhotoRequest,
  type NativePhotoResult,
} from './native-photo-sandbox.protocol';
import { readPhotoFrame } from './native-photo-sandbox.transport';

export class NativePhotoSandboxClient {
  constructor(private readonly socketPath: string) {
    if (
      !/^\/[A-Za-z0-9._/-]+\.sock$/u.test(socketPath) ||
      socketPath.length > 100 ||
      socketPath.includes('/../') ||
      socketPath.includes('//')
    )
      throw new Error('Invalid photo sandbox socket path');
  }

  async fingerprint(
    input: Uint8Array,
    request: Omit<NativePhotoRequest, 'operation'>,
  ): Promise<NativePhotoResult> {
    const deadlineAtMs = Math.min(request.deadlineAtMs, Date.now() + PHOTO_NATIVE_MAX_EXECUTION_MS);
    if (deadlineAtMs <= Date.now()) return { kind: 'rejected', reason: 'decode_deadline_exceeded' };
    const frame = await this.exchange(
      { ...request, operation: 'fingerprint', deadlineAtMs },
      Buffer.from(input.buffer, input.byteOffset, input.byteLength),
      deadlineAtMs,
    );
    return parsePhotoResult(frame.metadata);
  }

  async probe(): Promise<Record<string, unknown>> {
    const frame = await this.exchange({ operation: 'probe' }, Buffer.alloc(0), Date.now() + 5_000);
    const status = frame.metadata;
    if (
      status.protocolVersion !== PHOTO_NATIVE_PROTOCOL_VERSION ||
      status.algorithmVersion !== PHOTO_FINGERPRINT_ALGORITHM_VERSION ||
      status.network !== 'none' ||
      status.environment !== 'allowlist' ||
      status.processGroupTeardown !== 'verified_or_cgroup_recycle' ||
      typeof status.instanceId !== 'string'
    )
      throw new Error('Photo sandbox boundary attestation failed');
    return status;
  }

  async smoke(): Promise<void> {
    await this.probe();
    const input = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgCbjTAMIMGAwAhZsKUeANHEMAAAAASUVORK5CYII=',
      'base64',
    );
    const result = await this.fingerprint(input, {
      deadlineAtMs: Date.now() + 5_000,
      maxInputBytes: 16_777_216,
      maxInputPixels: 40_000_000,
      remainingEncodedBytes: input.length,
      remainingPixels: 6,
      expectedFormat: 'png',
    });
    if (
      result.kind !== 'complete' ||
      result.fingerprint.canonicalHash !==
        '44dcf8dcd218b35c9df6fc969e35ee46f36b984e2cc26e109a7addfff4155377'
    )
      throw new Error('Photo sandbox raster smoke failed');
  }

  private async exchange(metadata: object, payload: Buffer, deadlineAtMs: number) {
    const frame = encodePhotoFrame(metadata, payload);
    const socket = createConnection({ path: this.socketPath });
    const result = readPhotoFrame(socket, deadlineAtMs, 0);
    socket.once('connect', () => socket.write(frame));
    try {
      return await result;
    } finally {
      socket.destroy();
    }
  }
}
