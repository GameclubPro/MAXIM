import type { PhotoFingerprint, SupportedPhotoFormat } from './photo-fingerprint';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint-version';

export const PHOTO_NATIVE_SOCKET_PATH = '/run/maxim-photo/native-photo.sock';
export const PHOTO_NATIVE_MAX_BYTES = 16_777_216;
export const PHOTO_NATIVE_MAX_PIXELS = 40_000_000;
export const PHOTO_NATIVE_MAX_METADATA_BYTES = 2_048;
export const PHOTO_NATIVE_MAX_EXECUTION_MS = 30_000;
export const PHOTO_NATIVE_TEARDOWN_GRACE_MS = 500;
export const PHOTO_NATIVE_HEADER_BYTES = 12;
export const PHOTO_NATIVE_PROTOCOL_VERSION = 1;
const MAGIC = Buffer.from('MXPH');

export type NativePhotoRequest = {
  operation: 'fingerprint';
  deadlineAtMs: number;
  maxInputBytes: number;
  maxInputPixels: number;
  remainingEncodedBytes: number;
  remainingPixels: number;
  expectedFormat?: SupportedPhotoFormat;
};
export type NativePhotoResult =
  | { kind: 'complete'; fingerprint: PhotoFingerprint }
  | {
      kind: 'rejected';
      reason:
        | 'unsupported_image'
        | 'unsupported_multi_frame'
        | 'image_byte_limit_exceeded'
        | 'image_pixel_limit_exceeded'
        | 'album_decode_budget_exceeded'
        | 'decode_deadline_exceeded'
        | 'decode_capacity_exceeded'
        | 'native_unavailable';
    };

export function encodePhotoFrame(metadata: object, payload: Buffer = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(metadata));
  if (json.length > PHOTO_NATIVE_MAX_METADATA_BYTES || payload.length > PHOTO_NATIVE_MAX_BYTES) {
    throw new Error('Photo sandbox frame exceeds bounds');
  }
  const header = Buffer.alloc(PHOTO_NATIVE_HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(json.length, 4);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, json, payload]);
}

export function photoFrameLength(header: Buffer, maxPayloadBytes = PHOTO_NATIVE_MAX_BYTES): number {
  if (header.length < PHOTO_NATIVE_HEADER_BYTES || !header.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Invalid photo sandbox header');
  }
  const metadataBytes = header.readUInt32BE(4);
  const payloadBytes = header.readUInt32BE(8);
  if (
    metadataBytes < 2 ||
    metadataBytes > PHOTO_NATIVE_MAX_METADATA_BYTES ||
    payloadBytes > maxPayloadBytes
  ) {
    throw new Error('Photo sandbox frame exceeds bounds');
  }
  return PHOTO_NATIVE_HEADER_BYTES + metadataBytes + payloadBytes;
}

export function decodePhotoFrame(
  bytes: Buffer,
  maxPayloadBytes = PHOTO_NATIVE_MAX_BYTES,
): { metadata: Record<string, unknown>; payload: Buffer } {
  const length = photoFrameLength(bytes, maxPayloadBytes);
  if (bytes.length !== length) throw new Error('Invalid photo sandbox frame length');
  const offset = PHOTO_NATIVE_HEADER_BYTES + bytes.readUInt32BE(4);
  const metadata: unknown = JSON.parse(
    bytes.subarray(PHOTO_NATIVE_HEADER_BYTES, offset).toString('utf8'),
  );
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Invalid photo sandbox metadata');
  return { metadata: metadata as Record<string, unknown>, payload: bytes.subarray(offset) };
}

export function parsePhotoRequest(value: Record<string, unknown>): NativePhotoRequest {
  if (value.operation !== 'fingerprint' || !Number.isSafeInteger(value.deadlineAtMs))
    throw new Error('Invalid photo request');
  for (const key of ['maxInputBytes', 'remainingEncodedBytes'] as const) {
    if (
      !Number.isSafeInteger(value[key]) ||
      Number(value[key]) < 1 ||
      Number(value[key]) > PHOTO_NATIVE_MAX_BYTES * 4
    )
      throw new Error('Invalid photo byte budget');
  }
  for (const key of ['maxInputPixels', 'remainingPixels'] as const) {
    if (
      !Number.isSafeInteger(value[key]) ||
      Number(value[key]) < 1 ||
      Number(value[key]) > PHOTO_NATIVE_MAX_PIXELS * 4
    )
      throw new Error('Invalid photo pixel budget');
  }
  if (
    Number(value.maxInputBytes) > PHOTO_NATIVE_MAX_BYTES ||
    Number(value.maxInputPixels) > PHOTO_NATIVE_MAX_PIXELS
  )
    throw new Error('Invalid photo input limit');
  if (
    value.expectedFormat !== undefined &&
    !['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(String(value.expectedFormat))
  )
    throw new Error('Invalid photo format');
  return value as NativePhotoRequest;
}

export function parsePhotoResult(value: unknown): NativePhotoResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid photo result');
  const result = value as NativePhotoResult;
  if (
    result.kind === 'rejected' &&
    [
      'unsupported_image',
      'unsupported_multi_frame',
      'image_byte_limit_exceeded',
      'image_pixel_limit_exceeded',
      'album_decode_budget_exceeded',
      'decode_deadline_exceeded',
      'decode_capacity_exceeded',
      'native_unavailable',
    ].includes(result.reason)
  )
    return result;
  if (result.kind !== 'complete') throw new Error('Invalid photo result');
  const proof = result.fingerprint;
  const cost = proof?.decodeCost;
  if (
    proof?.algorithmVersion !== PHOTO_FINGERPRINT_ALGORITHM_VERSION ||
    !/^[a-f0-9]{64}$/.test(proof.canonicalHash) ||
    proof.pdqHash !== '0'.repeat(64) ||
    proof.pdqQuality !== 0 ||
    !cost ||
    !Number.isSafeInteger(cost.encodedBytes) ||
    cost.encodedBytes < 1 ||
    cost.encodedBytes > PHOTO_NATIVE_MAX_BYTES ||
    !Number.isSafeInteger(cost.pixels) ||
    cost.pixels < 1 ||
    cost.pixels > PHOTO_NATIVE_MAX_PIXELS
  )
    throw new Error('Invalid photo proof');
  return result;
}
