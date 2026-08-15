import { createRequire } from 'node:module';
import { UnrecoverableError } from 'bullmq';

type DetectedFileType = { ext: string; mime: string };
type FileTypeRuntime = {
  fileTypeFromBuffer(data: Uint8Array | ArrayBuffer): Promise<DetectedFileType | undefined>;
};

type MediaInputFormat = object;
type EncodedVideoPacket = {
  byteLength: number;
  data: Uint8Array;
  type: string;
};
type VideoDecoderConfiguration = {
  description?: ArrayBuffer | ArrayBufferView;
};
type MediaVideoTrack = {
  determinePacketType(packet: EncodedVideoPacket): Promise<string>;
  getCodec(): Promise<string | null>;
  getDecoderConfig(): Promise<VideoDecoderConfiguration | null>;
};
type MediaInput = {
  dispose(): void;
  getPrimaryVideoTrack(): Promise<MediaVideoTrack | null>;
};
type MediaPacketSink = {
  getFirstPacket(options: { skipLiveWait: true }): Promise<EncodedVideoPacket | null>;
  getPacket(timestamp: number, options: { skipLiveWait: true }): Promise<EncodedVideoPacket | null>;
};
type MediabunnyRuntime = {
  BufferSource: new (data: Uint8Array) => unknown;
  EncodedPacketSink: new (track: MediaVideoTrack) => MediaPacketSink;
  Input: new (options: { formats: MediaInputFormat[]; source: unknown }) => MediaInput;
  MATROSKA: MediaInputFormat;
  MP4: MediaInputFormat;
  QTFF: MediaInputFormat;
  WEBM: MediaInputFormat;
};

const requireFromHere = createRequire(__filename);
let fileTypeRuntime: FileTypeRuntime | null = null;
let mediabunnyRuntime: MediabunnyRuntime | null = null;

function getFileTypeRuntime(): FileTypeRuntime {
  return (fileTypeRuntime ??= requireFromHere('file-type/core') as FileTypeRuntime);
}

function getMediabunnyRuntime(): MediabunnyRuntime {
  return (mediabunnyRuntime ??= requireFromHere('mediabunny') as MediabunnyRuntime);
}

export const MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX = 7_680;

const MAX_IMAGE_UPLOAD_MAX_PIXELS =
  MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX * MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX;
const MAX_ANIMATED_IMAGE_DECODE_PIXELS = MAX_IMAGE_UPLOAD_MAX_PIXELS;
const MAX_GIF_FRAME_COUNT = 10_000;
const MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES = 256 * 1024;
const ZERO_SCAN_CHUNK = Buffer.alloc(64 * 1024);
const ANNEX_B_START_CODE = Buffer.from([0, 0, 1]);
const MAX_HEIC_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_HEIC_BOXES = 4_096;
const MAX_HEIC_FTYP_BYTES = 64 * 1024;
const MAX_CODEC_NAL_UNITS = 16_384;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 108, 124]);
const BMP_SUPPORTED_BITS_PER_PIXEL = new Set([1, 4, 8, 16, 24, 32]);
const BMP_COMPRESSION_RGB = 0;
const BMP_COMPRESSION_RLE8 = 1;
const BMP_COMPRESSION_RLE4 = 2;
const BMP_COMPRESSION_BITFIELDS = 3;
const BMP_COMPRESSION_ALPHABITFIELDS = 6;

const IMAGE_FORMATS = {
  jpg: { format: 'jpeg', extension: 'jpg', mimeType: 'image/jpeg' },
  png: { format: 'png', extension: 'png', mimeType: 'image/png' },
  gif: { format: 'gif', extension: 'gif', mimeType: 'image/gif' },
  tif: { format: 'tiff', extension: 'tiff', mimeType: 'image/tiff' },
  bmp: { format: 'bmp', extension: 'bmp', mimeType: 'image/bmp' },
  heic: { format: 'heic', extension: 'heic', mimeType: 'image/heic' },
} as const;

const VIDEO_FORMATS = {
  mp4: { format: 'mp4', extension: 'mp4', mimeType: 'video/mp4' },
  mov: { format: 'mov', extension: 'mov', mimeType: 'video/quicktime' },
  mkv: { format: 'mkv', extension: 'mkv', mimeType: 'video/x-matroska' },
  webm: { format: 'webm', extension: 'webm', mimeType: 'video/webm' },
} as const;

export type MaxValidatedImageUpload = (typeof IMAGE_FORMATS)[keyof typeof IMAGE_FORMATS] & {
  uploadType: 'image';
  width: number;
  height: number;
};

export type MaxValidatedVideoUpload = (typeof VIDEO_FORMATS)[keyof typeof VIDEO_FORMATS] & {
  uploadType: 'video';
};

export type MaxValidatedMediaUpload = MaxValidatedImageUpload | MaxValidatedVideoUpload;

export const MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: 'MAX_MEDIA_UPLOAD_INVALID_PAYLOAD',
  UNSUPPORTED_FORMAT: 'MAX_MEDIA_UPLOAD_UNSUPPORTED_FORMAT',
  IMAGE_DIMENSIONS_EXCEEDED: 'MAX_IMAGE_UPLOAD_DIMENSIONS_EXCEEDED',
  IMAGE_DECODE_BUDGET_EXCEEDED: 'MAX_IMAGE_UPLOAD_DECODE_BUDGET_EXCEEDED',
} as const);

export type MaxMediaUploadValidationErrorCode =
  (typeof MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES)[keyof typeof MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES];

const MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGES = Object.freeze({
  INVALID_PAYLOAD: 'Не удалось распознать файл. Выберите исправный файл поддерживаемого формата.',
  UNSUPPORTED_IMAGE:
    'Формат изображения не поддерживается MAX. Используйте JPG, PNG, GIF, TIFF, BMP или HEIC.',
  UNSUPPORTED_VIDEO: 'Формат видео не поддерживается MAX. Используйте MP4, MOV, MKV или WEBM.',
  IMAGE_DIMENSIONS_EXCEEDED: 'Размер изображения превышает 7680x7680 пикселей.',
  IMAGE_DECODE_BUDGET_EXCEEDED:
    'Анимированное изображение слишком большое или содержит слишком много кадров.',
} as const);

const MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGE_SET = new Set<string>(
  Object.values(MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGES),
);

export class MaxMediaUploadValidationError extends UnrecoverableError {
  readonly code: MaxMediaUploadValidationErrorCode;
  readonly uploadType: 'image' | 'video';
  readonly detectedExtension: string | null;
  readonly publicMessage: string;
  readonly retryable = false;
  readonly preDispatch = true;

  constructor(
    code: MaxMediaUploadValidationErrorCode,
    uploadType: 'image' | 'video',
    options: { cause?: unknown; detectedExtension?: string | null } = {},
  ) {
    super(resolveValidationErrorMessage(code, uploadType));
    this.name = 'MaxMediaUploadValidationError';
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
        writable: true,
      });
    }
    this.code = code;
    this.uploadType = uploadType;
    this.detectedExtension = options.detectedExtension ?? null;
    this.publicMessage = resolveValidationErrorPublicMessage(code, uploadType);
  }
}

export function isMaxMediaUploadValidationPublicMessage(value: string): boolean {
  return MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGE_SET.has(value.trim());
}

export async function validateMaxMediaUploadPayload(
  uploadType: 'image',
  data: Buffer,
): Promise<MaxValidatedImageUpload>;
export async function validateMaxMediaUploadPayload(
  uploadType: 'video',
  data: Buffer,
): Promise<MaxValidatedVideoUpload>;
export async function validateMaxMediaUploadPayload(
  uploadType: 'image' | 'video',
  data: Buffer,
): Promise<MaxValidatedMediaUpload> {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      uploadType,
    );
  }

  let detected: DetectedFileType | undefined;
  try {
    detected = await getFileTypeRuntime().fileTypeFromBuffer(data);
  } catch (error: unknown) {
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      uploadType,
      { cause: error },
    );
  }

  if (!detected) {
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      uploadType,
    );
  }

  if (uploadType === 'video') {
    const format = detected.ext as keyof typeof VIDEO_FORMATS;
    const policy = VIDEO_FORMATS[format];
    if (!policy) {
      throw new MaxMediaUploadValidationError(
        MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT,
        uploadType,
        { detectedExtension: detected.ext },
      );
    }

    await validateVideoContainer(format, data);
    return { uploadType, ...policy };
  }

  const policy = IMAGE_FORMATS[detected.ext as keyof typeof IMAGE_FORMATS];
  if (!policy) {
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT,
      uploadType,
      { detectedExtension: detected.ext },
    );
  }

  const dimensions = await readImageDimensions(policy.format, data);
  assertImageDimensions(dimensions.width, dimensions.height, detected.ext);
  return { uploadType, ...policy, ...dimensions } as MaxValidatedImageUpload;
}

type ImageDimensions = { width: number; height: number };

async function validateVideoContainer(
  format: keyof typeof VIDEO_FORMATS,
  data: Buffer,
): Promise<void> {
  let input: MediaInput | null = null;
  try {
    const { BufferSource, EncodedPacketSink, Input, MATROSKA, MP4, QTFF, WEBM } =
      getMediabunnyRuntime();
    const inputFormats: Record<keyof typeof VIDEO_FORMATS, MediaInputFormat> = {
      mp4: MP4,
      mov: QTFF,
      mkv: MATROSKA,
      webm: WEBM,
    };
    input = new Input({
      formats: [inputFormats[format]],
      source: new BufferSource(data),
    });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new TypeError('Video container has no primary video track');
    }

    const codec = await videoTrack.getCodec();
    const decoderConfig = await videoTrack.getDecoderConfig();
    if (!codec || !decoderConfig) {
      throw new TypeError('Video track has no supported codec configuration');
    }

    const sink = new EncodedPacketSink(videoTrack);
    const packetOptions = { skipLiveWait: true } as const;
    const firstPacket = await sink.getFirstPacket(packetOptions);
    const lastPacket = await sink.getPacket(Number.POSITIVE_INFINITY, packetOptions);
    if (
      !firstPacket ||
      firstPacket.byteLength <= 0 ||
      firstPacket.data.byteLength <= 0 ||
      firstPacket.byteLength !== firstPacket.data.byteLength ||
      !lastPacket ||
      lastPacket.byteLength <= 0 ||
      lastPacket.data.byteLength <= 0 ||
      lastPacket.byteLength !== lastPacket.data.byteLength
    ) {
      throw new TypeError('Video container has no complete encoded video packets');
    }

    const firstPacketType = await videoTrack.determinePacketType(firstPacket);
    if (firstPacket.type !== 'key' || firstPacketType !== 'key') {
      throw new TypeError('Video does not start with a valid key packet');
    }
    await validateEncodedVideoPacket(codec, decoderConfig, firstPacket.data);
  } catch (error: unknown) {
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'video',
      { cause: error, detectedExtension: format },
    );
  } finally {
    try {
      input?.dispose();
    } catch {
      // Disposal is best-effort after a fully in-memory parse.
    }
  }
}

async function validateEncodedVideoPacket(
  codec: string,
  decoderConfig: VideoDecoderConfiguration,
  packetData: Uint8Array,
): Promise<void> {
  if (packetData.byteLength === 0) {
    throw new TypeError('Encoded video packet is empty');
  }

  if (codec === 'avc' || codec === 'hevc') {
    const description = decoderConfig.description ? toUint8Array(decoderConfig.description) : null;
    const lengthSize = description
      ? readDecoderConfigurationNalLengthSize(codec, description)
      : null;
    await validateNalPacket(codec, packetData, lengthSize);
    return;
  }

  if (codec === 'vp8') {
    validateVp8KeyPacket(packetData);
    return;
  }

  if (codec === 'vp9' || codec === 'av1') {
    if (await containsOnlyZeroBytes(packetData)) {
      throw new TypeError(`${codec.toUpperCase()} packet contains no encoded data`);
    }
    return;
  }

  if (codec === 'prores') {
    if (
      packetData.byteLength < 8 ||
      readUnsignedBigEndian(packetData, 0, 4) !== packetData.byteLength ||
      String.fromCharCode(...packetData.subarray(4, 8)) !== 'icpf'
    ) {
      throw new TypeError('Invalid ProRes frame header');
    }
    return;
  }

  throw new TypeError('Unsupported encoded video codec');
}

function readDecoderConfigurationNalLengthSize(
  codec: 'avc' | 'hevc',
  description: Uint8Array,
): 1 | 2 | 3 | 4 {
  const lengthSizeOffset = codec === 'avc' ? 4 : 21;
  if (description.byteLength <= lengthSizeOffset || description[0] !== 1) {
    throw new TypeError(`Invalid ${codec.toUpperCase()} decoder configuration`);
  }
  return ((description[lengthSizeOffset] & 0x03) + 1) as 1 | 2 | 3 | 4;
}

async function validateNalPacket(
  codec: 'avc' | 'hevc',
  packetData: Uint8Array,
  lengthSize: 1 | 2 | 3 | 4 | null,
): Promise<void> {
  let nalCount = 0;
  let hasVclNal = false;
  const validateNal = (offset: number, length: number) => {
    nalCount += 1;
    if (nalCount > MAX_CODEC_NAL_UNITS) {
      throw new TypeError('Encoded packet contains too many NAL units');
    }
    hasVclNal ||= validateNalHeader(codec, packetData, offset, length);
  };

  if (lengthSize !== null) {
    let offset = 0;
    while (offset < packetData.byteLength) {
      if (offset + lengthSize > packetData.byteLength) {
        throw new TypeError('Truncated length-prefixed NAL unit');
      }
      const nalLength = readUnsignedBigEndian(packetData, offset, lengthSize);
      offset += lengthSize;
      if (nalLength <= 0 || offset + nalLength > packetData.byteLength) {
        throw new TypeError('Invalid length-prefixed NAL unit boundary');
      }
      validateNal(offset, nalLength);
      offset += nalLength;
    }
  } else {
    let startCode = await findAnnexBStartCode(packetData, 0, true);
    if (!startCode) {
      throw new TypeError('Annex-B packet has no leading start code');
    }

    while (startCode) {
      const nextStartCode = await findAnnexBStartCode(packetData, startCode.nalOffset);
      const nalEnd = await trimAnnexBTrailingZeros(
        packetData,
        startCode.nalOffset,
        nextStartCode?.prefixOffset ?? packetData.byteLength,
      );
      validateNal(startCode.nalOffset, nalEnd - startCode.nalOffset);
      startCode = nextStartCode;
    }
  }

  if (nalCount === 0 || !hasVclNal) {
    throw new TypeError('Encoded packet has no video coding NAL unit');
  }
}

function validateNalHeader(
  codec: 'avc' | 'hevc',
  data: Uint8Array,
  offset: number,
  length: number,
): boolean {
  if (codec === 'avc') {
    if (length < 2 || (data[offset] & 0x80) !== 0) {
      throw new TypeError('Invalid AVC NAL unit header');
    }
    const nalType = data[offset] & 0x1f;
    if (nalType === 0 || nalType > 23) {
      throw new TypeError('Unsupported AVC NAL unit type');
    }
    return nalType >= 1 && nalType <= 5;
  }

  if (length < 3 || (data[offset] & 0x80) !== 0 || (data[offset + 1] & 0x07) === 0) {
    throw new TypeError('Invalid HEVC NAL unit header');
  }
  return ((data[offset] >> 1) & 0x3f) <= 31;
}

async function findAnnexBStartCode(
  data: Uint8Array,
  from: number,
  requireZeroPrefix = false,
): Promise<{ prefixOffset: number; nalOffset: number } | null> {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let cursor = from;
  while (cursor + ANNEX_B_START_CODE.length <= data.byteLength) {
    const scanEnd = Math.min(
      cursor + MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES + ANNEX_B_START_CODE.length - 1,
      data.byteLength,
    );
    const relativeOffset = bytes.subarray(cursor, scanEnd).indexOf(ANNEX_B_START_CODE);
    const startCodeOffset = relativeOffset >= 0 ? cursor + relativeOffset : -1;
    const prefixOffset =
      startCodeOffset > from && data[startCodeOffset - 1] === 0
        ? startCodeOffset - 1
        : startCodeOffset;
    const checkedEnd =
      startCodeOffset >= 0
        ? prefixOffset
        : Math.min(cursor + MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES, data.byteLength);
    if (requireZeroPrefix && !containsOnlyZeroBytesInRange(bytes, cursor, checkedEnd)) {
      return null;
    }
    if (startCodeOffset >= 0) {
      return { prefixOffset, nalOffset: startCodeOffset + ANNEX_B_START_CODE.length };
    }
    cursor = checkedEnd;
    if (cursor + ANNEX_B_START_CODE.length <= data.byteLength) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return null;
}

async function trimAnnexBTrailingZeros(
  data: Uint8Array,
  start: number,
  end: number,
): Promise<number> {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let cursor = end;
  let bytesSinceYield = 0;
  while (cursor > start) {
    const chunkStart = Math.max(start, cursor - ZERO_SCAN_CHUNK.length);
    const chunk = bytes.subarray(chunkStart, cursor);
    if (!chunk.equals(ZERO_SCAN_CHUNK.subarray(0, chunk.length))) {
      for (let offset = cursor - 1; offset >= chunkStart; offset -= 1) {
        if (data[offset] !== 0) {
          return offset + 1;
        }
      }
    }
    bytesSinceYield += cursor - chunkStart;
    cursor = chunkStart;
    if (bytesSinceYield >= MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES && cursor > start) {
      bytesSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return cursor;
}

function containsOnlyZeroBytesInRange(data: Buffer, start: number, end: number): boolean {
  let cursor = start;
  while (cursor < end) {
    const chunkEnd = Math.min(cursor + ZERO_SCAN_CHUNK.length, end);
    if (!data.subarray(cursor, chunkEnd).equals(ZERO_SCAN_CHUNK.subarray(0, chunkEnd - cursor))) {
      return false;
    }
    cursor = chunkEnd;
  }
  return true;
}

async function containsOnlyZeroBytes(data: Uint8Array): Promise<boolean> {
  let cursor = 0;
  let bytesSinceYield = 0;
  while (cursor < data.byteLength) {
    const end = Math.min(cursor + ZERO_SCAN_CHUNK.length, data.byteLength);
    const chunk = Buffer.from(data.buffer, data.byteOffset + cursor, end - cursor);
    if (!chunk.equals(ZERO_SCAN_CHUNK.subarray(0, end - cursor))) {
      return false;
    }
    bytesSinceYield += end - cursor;
    cursor = end;
    if (bytesSinceYield >= MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES && cursor < data.byteLength) {
      bytesSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return true;
}

export const MAX_MEDIA_UPLOAD_VALIDATION_TEST_BOUNDARY = Object.freeze({
  validateEncodedVideoPacket,
});

function validateVp8KeyPacket(packetData: Uint8Array): void {
  if (packetData.byteLength < 10 || (packetData[0] & 1) !== 0) {
    throw new TypeError('Invalid VP8 key frame header');
  }
  const frameTag = packetData[0] | (packetData[1] << 8) | (packetData[2] << 16);
  const bitstreamVersion = (frameTag >> 1) & 0x07;
  const firstPartitionLength = frameTag >>> 5;
  if (
    bitstreamVersion > 3 ||
    firstPartitionLength <= 0 ||
    firstPartitionLength > packetData.byteLength - 3 ||
    packetData[3] !== 0x9d ||
    packetData[4] !== 0x01 ||
    packetData[5] !== 0x2a
  ) {
    throw new TypeError('Invalid VP8 key frame payload');
  }
  const width = (packetData[6] | (packetData[7] << 8)) & 0x3fff;
  const height = (packetData[8] | (packetData[9] << 8)) & 0x3fff;
  if (width === 0 || height === 0) {
    throw new TypeError('Invalid VP8 key frame dimensions');
  }
}

function readUnsignedBigEndian(data: Uint8Array, offset: number, bytes: number): number {
  let value = 0;
  for (let index = 0; index < bytes; index += 1) {
    value = value * 256 + data[offset + index];
  }
  return value;
}

function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

async function readImageDimensions(
  format: MaxValidatedImageUpload['format'],
  data: Buffer,
): Promise<ImageDimensions> {
  if (format === 'bmp') {
    return readBmpDimensions(data);
  }
  if (format === 'heic') {
    return readHeicDimensions(data);
  }

  try {
    const gifInspection = format === 'gif' ? await inspectGifDataStream(data) : null;
    const { default: sharp } = await import('sharp');
    const image = sharp(data, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_UPLOAD_MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== format ||
      metadata.width === undefined ||
      metadata.height === undefined
    ) {
      throw new TypeError('Image metadata does not match the detected format');
    }
    if (
      gifInspection &&
      (metadata.width !== gifInspection.width ||
        (metadata.pageHeight ?? metadata.height) !== gifInspection.height ||
        (metadata.pages ?? 1) !== gifInspection.frameCount)
    ) {
      throw new TypeError('GIF decoder metadata does not match its complete data stream');
    }
    await image.stats();

    return gifInspection
      ? { width: gifInspection.width, height: gifInspection.height }
      : { width: metadata.width, height: metadata.pageHeight ?? metadata.height };
  } catch (error: unknown) {
    if (isSharpPixelLimitError(error)) {
      throw new MaxMediaUploadValidationError(
        MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED,
        'image',
        { cause: error },
      );
    }
    if (error instanceof MaxMediaUploadValidationError) {
      throw error;
    }
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
      { cause: error },
    );
  }
}

type GifInspection = ImageDimensions & { frameCount: number };
type CooperativeByteScan = { nextYieldOffset: number };

async function inspectGifDataStream(data: Buffer): Promise<GifInspection> {
  if (
    data.length < 13 ||
    (data.toString('ascii', 0, 6) !== 'GIF87a' && data.toString('ascii', 0, 6) !== 'GIF89a')
  ) {
    throw new TypeError('Invalid GIF header');
  }

  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  assertImageDimensions(width, height, 'gif');

  let cursor = 13;
  const scan: CooperativeByteScan = {
    nextYieldOffset: MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES,
  };
  if ((data[10] & 0x80) !== 0) {
    cursor += 3 * 2 ** ((data[10] & 0x07) + 1);
  }
  if (cursor > data.length) {
    throw new TypeError('Truncated GIF global color table');
  }

  let frameCount = 0;
  while (cursor < data.length) {
    const marker = data[cursor];
    cursor += 1;
    const scanYield = yieldDuringByteScan(scan, cursor);
    if (scanYield) {
      await scanYield;
    }
    if (marker === 0x3b) {
      if (frameCount === 0) {
        throw new TypeError('GIF contains no image frames');
      }
      await assertZeroGifTrailerPadding(data, cursor, scan);
      return { width, height, frameCount };
    }

    if (marker === 0x21) {
      if (cursor >= data.length) {
        throw new TypeError('Truncated GIF extension');
      }
      cursor += 1;
      cursor = await skipGifSubBlocks(data, cursor, scan);
      continue;
    }

    if (marker === 0x2c) {
      if (cursor + 9 > data.length) {
        throw new TypeError('Truncated GIF image descriptor');
      }
      const left = data.readUInt16LE(cursor);
      const top = data.readUInt16LE(cursor + 2);
      const frameWidth = data.readUInt16LE(cursor + 4);
      const frameHeight = data.readUInt16LE(cursor + 6);
      if (
        frameWidth === 0 ||
        frameHeight === 0 ||
        left + frameWidth > width ||
        top + frameHeight > height
      ) {
        throw new TypeError('GIF image descriptor exceeds its logical screen');
      }
      frameCount += 1;
      const aggregatePixels = BigInt(width) * BigInt(height) * BigInt(frameCount);
      if (
        frameCount > MAX_GIF_FRAME_COUNT ||
        aggregatePixels > BigInt(MAX_ANIMATED_IMAGE_DECODE_PIXELS)
      ) {
        throw new MaxMediaUploadValidationError(
          MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED,
          'image',
          { detectedExtension: 'gif' },
        );
      }
      const packed = data[cursor + 8];
      cursor += 9;
      if ((packed & 0x80) !== 0) {
        cursor += 3 * 2 ** ((packed & 0x07) + 1);
      }
      if (cursor >= data.length) {
        throw new TypeError('Truncated GIF image data');
      }
      const minimumCodeSize = data[cursor];
      if (minimumCodeSize < 2 || minimumCodeSize > 8) {
        throw new TypeError('Invalid GIF LZW minimum code size');
      }
      cursor += 1;
      cursor = await skipGifSubBlocks(data, cursor, scan);
      continue;
    }

    throw new TypeError('Invalid GIF data stream marker');
  }

  throw new TypeError('GIF trailer is missing');
}

async function skipGifSubBlocks(
  data: Buffer,
  start: number,
  scan: CooperativeByteScan,
): Promise<number> {
  let cursor = start;
  while (cursor < data.length) {
    const blockLength = data[cursor];
    cursor += 1;
    if (blockLength === 0) {
      return cursor;
    }
    cursor += blockLength;
    if (cursor > data.length) {
      throw new TypeError('Truncated GIF data sub-block');
    }
    const scanYield = yieldDuringByteScan(scan, cursor);
    if (scanYield) {
      await scanYield;
    }
  }
  throw new TypeError('GIF data sub-block terminator is missing');
}

async function assertZeroGifTrailerPadding(
  data: Buffer,
  start: number,
  scan: CooperativeByteScan,
): Promise<void> {
  let cursor = start;
  while (cursor < data.length) {
    const end = Math.min(cursor + ZERO_SCAN_CHUNK.length, data.length);
    if (!data.subarray(cursor, end).equals(ZERO_SCAN_CHUNK.subarray(0, end - cursor))) {
      throw new TypeError('Unexpected data after the GIF trailer');
    }
    cursor = end;
    const scanYield = yieldDuringByteScan(scan, cursor);
    if (scanYield) {
      await scanYield;
    }
  }
}

function yieldDuringByteScan(scan: CooperativeByteScan, cursor: number): Promise<void> | null {
  if (cursor < scan.nextYieldOffset) {
    return null;
  }
  scan.nextYieldOffset = cursor + MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES;
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function readBmpDimensions(data: Buffer): Promise<ImageDimensions> {
  try {
    if (data.length < 26 || data.toString('ascii', 0, 2) !== 'BM') {
      throw new TypeError('Invalid BMP header');
    }

    const declaredFileSize = data.readUInt32LE(2);
    if (declaredFileSize !== data.length) {
      throw new TypeError('BMP file size does not match the payload');
    }

    const dibSize = data.readUInt32LE(14);
    if (!BMP_DIB_HEADER_SIZES.has(dibSize) || 14 + dibSize > data.length) {
      throw new TypeError('Unsupported or truncated BMP DIB header');
    }

    const pixelOffset = data.readUInt32LE(10);
    if (pixelOffset < 14 + dibSize || pixelOffset > data.length) {
      throw new TypeError('Invalid BMP pixel offset');
    }

    if (dibSize === 12) {
      const planes = data.readUInt16LE(22);
      if (planes !== 1) {
        throw new TypeError('Invalid BMP planes');
      }
      const width = data.readUInt16LE(18);
      const height = data.readUInt16LE(20);
      const bitsPerPixel = data.readUInt16LE(24);
      if (![1, 4, 8, 24].includes(bitsPerPixel)) {
        throw new TypeError('Unsupported BMP core pixel layout');
      }
      assertImageDimensions(width, height, 'bmp');
      const paletteEntries = bitsPerPixel <= 8 ? 2 ** bitsPerPixel : 0;
      const paletteEnd = 14 + dibSize + paletteEntries * 3;
      if (paletteEnd > pixelOffset) {
        throw new TypeError('BMP core palette overlaps its pixel payload');
      }
      const rowBytes = assertBmpFixedPixelData(
        data,
        pixelOffset,
        width,
        height,
        bitsPerPixel,
        null,
      );
      await validateBmpPaletteIndices(
        data,
        pixelOffset,
        rowBytes,
        width,
        height,
        bitsPerPixel,
        paletteEntries,
      );
      return { width, height };
    }

    if (data.readUInt16LE(26) !== 1) {
      throw new TypeError('Invalid BMP planes');
    }
    const width = data.readInt32LE(18);
    const signedHeight = data.readInt32LE(22);
    if (width <= 0 || signedHeight === 0 || signedHeight === -2_147_483_648) {
      throw new TypeError('Invalid BMP dimensions');
    }

    const height = Math.abs(signedHeight);
    const bitsPerPixel = data.readUInt16LE(28);
    const compression = data.readUInt32LE(30);
    const declaredImageSize = data.readUInt32LE(34);
    if (!BMP_SUPPORTED_BITS_PER_PIXEL.has(bitsPerPixel)) {
      throw new TypeError('Unsupported BMP pixel layout');
    }
    if (compression === BMP_COMPRESSION_RLE8 || compression === BMP_COMPRESSION_RLE4) {
      throw new TypeError('BMP RLE compression is not supported by the bounded validator');
    }
    const supportsCompression =
      (bitsPerPixel <= 8 && compression === BMP_COMPRESSION_RGB) ||
      (bitsPerPixel === 24 && compression === BMP_COMPRESSION_RGB) ||
      ((bitsPerPixel === 16 || bitsPerPixel === 32) &&
        [BMP_COMPRESSION_RGB, BMP_COMPRESSION_BITFIELDS, BMP_COMPRESSION_ALPHABITFIELDS].includes(
          compression,
        ));
    if (!supportsCompression) {
      throw new TypeError('Unsupported BMP compression and pixel-depth combination');
    }

    assertImageDimensions(width, height, 'bmp');
    const paletteStart = validateBmpBitfieldMasks(
      data,
      dibSize,
      bitsPerPixel,
      compression,
      pixelOffset,
    );
    const declaredPaletteEntries = data.readUInt32LE(46);
    const paletteEntries = resolveBmpPaletteEntries(bitsPerPixel, declaredPaletteEntries);
    const paletteEnd = paletteStart + paletteEntries * 4;
    if (!Number.isSafeInteger(paletteEnd) || paletteEnd > pixelOffset) {
      throw new TypeError('BMP palette overlaps its pixel payload');
    }
    const rowBytes = assertBmpFixedPixelData(
      data,
      pixelOffset,
      width,
      height,
      bitsPerPixel,
      declaredImageSize,
    );
    await validateBmpPaletteIndices(
      data,
      pixelOffset,
      rowBytes,
      width,
      height,
      bitsPerPixel,
      paletteEntries,
    );

    return { width, height };
  } catch (error: unknown) {
    if (error instanceof MaxMediaUploadValidationError) {
      throw error;
    }
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
      { cause: error, detectedExtension: 'bmp' },
    );
  }
}

function validateBmpBitfieldMasks(
  data: Buffer,
  dibSize: number,
  bitsPerPixel: number,
  compression: number,
  pixelOffset: number,
): number {
  const headerEnd = 14 + dibSize;
  if (compression !== BMP_COMPRESSION_BITFIELDS && compression !== BMP_COMPRESSION_ALPHABITFIELDS) {
    return headerEnd;
  }

  const maskCount = compression === BMP_COMPRESSION_ALPHABITFIELDS ? 4 : 3;
  let masks: number[];
  let paletteStart = headerEnd;
  if (dibSize === 40) {
    const maskBytes = maskCount * 4;
    paletteStart += maskBytes;
    if (paletteStart > pixelOffset || paletteStart > data.length) {
      throw new TypeError('BMP external bitfield masks are truncated');
    }
    masks = Array.from({ length: maskCount }, (_, index) =>
      data.readUInt32LE(headerEnd + index * 4),
    );
  } else {
    if (dibSize < 52 || (maskCount === 4 && dibSize < 56)) {
      throw new TypeError('BMP DIB header does not contain the required bitfield masks');
    }
    masks = Array.from({ length: maskCount }, (_, index) => data.readUInt32LE(14 + 40 + index * 4));
  }

  validateBmpChannelMasks(masks, bitsPerPixel, maskCount === 4);
  return paletteStart;
}

function validateBmpChannelMasks(
  masks: readonly number[],
  bitsPerPixel: number,
  alphaRequired: boolean,
): void {
  if (masks.length < 3 || masks.slice(0, 3).some((mask) => mask === 0)) {
    throw new TypeError('BMP RGB bitfield masks must be non-zero');
  }
  if (alphaRequired && masks[3] === 0) {
    throw new TypeError('BMP alpha bitfield mask must be non-zero');
  }

  const bitLimit = (1n << BigInt(bitsPerPixel)) - 1n;
  let occupied = 0n;
  for (const rawMask of masks) {
    const mask = BigInt(rawMask);
    if (mask === 0n && !alphaRequired) {
      continue;
    }
    if ((mask & ~bitLimit) !== 0n || (mask & occupied) !== 0n) {
      throw new TypeError('BMP bitfield masks overlap or exceed the pixel depth');
    }
    let normalized = mask;
    while (normalized !== 0n && (normalized & 1n) === 0n) {
      normalized >>= 1n;
    }
    if (normalized === 0n || (normalized & (normalized + 1n)) !== 0n) {
      throw new TypeError('BMP bitfield masks must contain contiguous bits');
    }
    occupied |= mask;
  }
}

function resolveBmpPaletteEntries(bitsPerPixel: number, declaredEntries: number): number {
  if (bitsPerPixel > 8) {
    if (declaredEntries !== 0) {
      throw new TypeError('BMP direct-color palettes are not supported by the bounded validator');
    }
    return 0;
  }

  const maximumEntries = 2 ** bitsPerPixel;
  const entries = declaredEntries === 0 ? maximumEntries : declaredEntries;
  if (entries <= 0 || entries > maximumEntries) {
    throw new TypeError('BMP palette size exceeds its pixel depth');
  }
  return entries;
}

function assertBmpFixedPixelData(
  data: Buffer,
  pixelOffset: number,
  width: number,
  height: number,
  bitsPerPixel: number,
  declaredImageSize: number | null,
): number {
  if (!BMP_SUPPORTED_BITS_PER_PIXEL.has(bitsPerPixel)) {
    throw new TypeError('Unsupported BMP pixel depth');
  }
  const rowBits = BigInt(width) * BigInt(bitsPerPixel);
  const rowBytes = ((rowBits + 31n) / 32n) * 4n;
  const expectedPixelBytes = rowBytes * BigInt(height);
  if (declaredImageSize !== null && declaredImageSize !== 0) {
    if (BigInt(declaredImageSize) !== expectedPixelBytes) {
      throw new TypeError('BMP image size does not match its dimensions');
    }
  }
  assertBmpPayloadRange(data, pixelOffset, expectedPixelBytes);
  return Number(rowBytes);
}

async function validateBmpPaletteIndices(
  data: Buffer,
  pixelOffset: number,
  rowBytes: number,
  width: number,
  height: number,
  bitsPerPixel: number,
  paletteEntries: number,
): Promise<void> {
  if (bitsPerPixel > 8 || paletteEntries === 2 ** bitsPerPixel) {
    return;
  }
  const packedPixelBytes = Math.ceil((width * bitsPerPixel) / 8);
  let scannedBytes = 0;
  for (let row = 0; row < height; row += 1) {
    const rowOffset = pixelOffset + row * rowBytes;
    for (let byteIndex = 0; byteIndex < packedPixelBytes; byteIndex += 1) {
      const value = data[rowOffset + byteIndex];
      const isInvalid =
        bitsPerPixel === 8
          ? value >= paletteEntries
          : bitsPerPixel === 4
            ? value >> 4 >= paletteEntries ||
              (byteIndex * 2 + 1 < width && (value & 0x0f) >= paletteEntries)
            : (value & resolveBmpOneBitPixelMask(byteIndex, width)) !== 0;
      if (isInvalid) {
        throw new TypeError('BMP pixel references a missing palette entry');
      }
    }
    scannedBytes += packedPixelBytes;
    if (scannedBytes >= MAX_MEDIA_VALIDATION_SYNC_SCAN_BYTES) {
      scannedBytes = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

function resolveBmpOneBitPixelMask(byteIndex: number, width: number): number {
  const remainingPixels = width - byteIndex * 8;
  return remainingPixels >= 8 ? 0xff : (0xff << (8 - remainingPixels)) & 0xff;
}

function assertBmpPayloadRange(data: Buffer, pixelOffset: number, pixelBytes: bigint): void {
  if (pixelBytes <= 0n || pixelBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('Invalid BMP pixel byte length');
  }
  const pixelEnd = BigInt(pixelOffset) + pixelBytes;
  if (pixelEnd > BigInt(data.length)) {
    throw new TypeError('BMP pixel payload is truncated');
  }
}

type IsoBox = {
  type: string;
  start: number;
  payloadStart: number;
  end: number;
};

type HeicParseBudget = { boxes: number };

type HeicByteRange = { start: number; end: number };

type HeicItemLocation = {
  itemId: number;
  constructionMethod: number;
  dataReferenceIndex: number;
  extents: HeicByteRange[];
};

type HeicItemInfo = {
  itemId: number;
  itemType: string | null;
};

type HeicCodedItem = {
  itemId: number;
  nalLengthSize: 1 | 2 | 3 | 4;
};

type HeicMeta = {
  primaryDimensions: ImageDimensions[];
  allDimensions: ImageDimensions[];
  locations: HeicItemLocation[];
  idatRanges: HeicByteRange[];
  codedItems: HeicCodedItem[];
};

function readHeicDimensions(data: Buffer): ImageDimensions {
  const budget: HeicParseBudget = { boxes: 0 };
  let offset = 0;
  let hasHeicBrand = false;
  let meta: HeicMeta | null = null;
  const mdatRanges: HeicByteRange[] = [];

  try {
    while (offset < data.length) {
      const box = readIsoBox(data, offset, data.length, budget);

      if (box.type === 'ftyp') {
        if (box.start >= MAX_HEIC_METADATA_BYTES) {
          throw new TypeError('HEIC ftyp box exceeds the inspection budget');
        }
        hasHeicBrand ||= readHeicBrands(data, box).some((brand) => HEIC_BRANDS.has(brand));
      } else if (box.type === 'meta') {
        if (meta || box.start >= MAX_HEIC_METADATA_BYTES || box.end > MAX_HEIC_METADATA_BYTES) {
          throw new TypeError('HEIC meta box exceeds the inspection budget');
        }
        meta = readHeicMeta(data, box, budget);
      } else if (box.type === 'mdat') {
        mdatRanges.push({ start: box.payloadStart, end: box.end });
      }

      offset = box.end;
    }

    if (!hasHeicBrand || !meta || meta.primaryDimensions.length === 0) {
      throw new TypeError('HEIC metadata is incomplete');
    }

    const itemRanges = validateHeicItemExtents(meta.locations, mdatRanges, meta.idatRanges);
    validateHeicCodedItems(data, meta.codedItems, itemRanges);
    for (const dimension of meta.allDimensions) {
      assertImageDimensions(dimension.width, dimension.height, 'heic');
    }
    return meta.primaryDimensions.reduce((largest, current) =>
      current.width * current.height > largest.width * largest.height ? current : largest,
    );
  } catch (error: unknown) {
    if (error instanceof MaxMediaUploadValidationError) {
      throw error;
    }
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
      { cause: error, detectedExtension: 'heic' },
    );
  }
}

function readHeicBrands(data: Buffer, box: IsoBox): string[] {
  const payloadLength = box.end - box.payloadStart;
  if (payloadLength < 8 || payloadLength > MAX_HEIC_FTYP_BYTES || (payloadLength - 8) % 4 !== 0) {
    throw new TypeError('Invalid HEIC ftyp box');
  }

  const brands = [data.toString('latin1', box.payloadStart, box.payloadStart + 4)];
  for (let offset = box.payloadStart + 8; offset < box.end; offset += 4) {
    brands.push(data.toString('latin1', offset, offset + 4));
  }
  return brands;
}

function readHeicMeta(data: Buffer, metaBox: IsoBox, budget: HeicParseBudget): HeicMeta {
  if (metaBox.payloadStart + 4 > metaBox.end) {
    throw new TypeError('Invalid HEIC meta box');
  }
  const metaVersion = data.readUInt8(metaBox.payloadStart);
  if (metaVersion !== 0) {
    throw new TypeError('Unsupported HEIC meta box version');
  }

  const children = readIsoBoxes(data, metaBox.payloadStart + 4, metaBox.end, budget);
  const pitm = requireSingleIsoBox(children, 'pitm');
  const iinf = requireSingleIsoBox(children, 'iinf');
  const iloc = requireSingleIsoBox(children, 'iloc');
  const iprp = requireSingleIsoBox(children, 'iprp');
  const primaryItemId = readHeicPrimaryItemId(data, pitm);
  const itemInfos = readHeicItemInfos(data, iinf, budget);
  if (!itemInfos.has(primaryItemId)) {
    throw new TypeError('HEIC primary item is missing from iinf');
  }

  const locations = readHeicItemLocations(data, iloc);
  if (!locations.some((location) => location.itemId === primaryItemId)) {
    throw new TypeError('HEIC primary item has no location');
  }

  const properties = readHeicImageProperties(data, iprp, primaryItemId, itemInfos, budget);
  return {
    ...properties,
    locations,
    idatRanges: children
      .filter((box) => box.type === 'idat')
      .map((box) => ({ start: box.payloadStart, end: box.end })),
  };
}

function readHeicPrimaryItemId(data: Buffer, box: IsoBox): number {
  const { version, cursor } = readFullBoxHeader(data, box);
  let itemId: number;
  if (version === 0) {
    assertReadable(cursor, 2, box.end);
    itemId = data.readUInt16BE(cursor);
  } else if (version === 1) {
    assertReadable(cursor, 4, box.end);
    itemId = data.readUInt32BE(cursor);
  } else {
    throw new TypeError('Unsupported HEIC pitm version');
  }
  if (itemId === 0) {
    throw new TypeError('Invalid HEIC primary item id');
  }
  return itemId;
}

function readHeicItemInfos(
  data: Buffer,
  box: IsoBox,
  budget: HeicParseBudget,
): Map<number, HeicItemInfo> {
  const header = readFullBoxHeader(data, box);
  if (header.version !== 0 && header.version !== 1) {
    throw new TypeError('Unsupported HEIC iinf version');
  }
  let cursor = header.cursor;
  let entryCount: number;
  if (header.version === 0) {
    assertReadable(cursor, 2, box.end);
    entryCount = data.readUInt16BE(cursor);
    cursor += 2;
  } else {
    assertReadable(cursor, 4, box.end);
    entryCount = data.readUInt32BE(cursor);
    cursor += 4;
  }
  if (entryCount <= 0 || entryCount > MAX_HEIC_BOXES) {
    throw new TypeError('Invalid HEIC iinf entry count');
  }

  const entries = readIsoBoxes(data, cursor, box.end, budget);
  if (entries.length !== entryCount || entries.some((entry) => entry.type !== 'infe')) {
    throw new TypeError('HEIC iinf entries are incomplete');
  }

  const itemInfos = new Map<number, HeicItemInfo>();
  for (const entry of entries) {
    const infe = readFullBoxHeader(data, entry);
    const itemIdBytes = infe.version === 3 ? 4 : infe.version <= 2 ? 2 : 0;
    if (itemIdBytes === 0) {
      throw new TypeError('Unsupported HEIC infe version');
    }
    assertReadable(infe.cursor, itemIdBytes, entry.end);
    const itemId =
      itemIdBytes === 4 ? data.readUInt32BE(infe.cursor) : data.readUInt16BE(infe.cursor);
    if (itemId === 0 || itemInfos.has(itemId)) {
      throw new TypeError('Duplicate HEIC item info');
    }
    let itemType: string | null = null;
    if (infe.version === 2 || infe.version === 3) {
      const itemTypeOffset = infe.cursor + itemIdBytes + 2;
      assertReadable(itemTypeOffset, 4, entry.end);
      itemType = data.toString('latin1', itemTypeOffset, itemTypeOffset + 4);
    }
    itemInfos.set(itemId, { itemId, itemType });
  }
  return itemInfos;
}

function readHeicItemLocations(data: Buffer, box: IsoBox): HeicItemLocation[] {
  const header = readFullBoxHeader(data, box);
  if (header.version !== 0 && header.version !== 1 && header.version !== 2) {
    throw new TypeError('Unsupported HEIC iloc version');
  }
  let cursor = header.cursor;
  assertReadable(cursor, 2, box.end);
  const offsetSize = data.readUInt8(cursor) >> 4;
  const lengthSize = data.readUInt8(cursor) & 0x0f;
  const baseOffsetSize = data.readUInt8(cursor + 1) >> 4;
  const indexSize = header.version === 0 ? 0 : data.readUInt8(cursor + 1) & 0x0f;
  cursor += 2;
  for (const size of [offsetSize, lengthSize, baseOffsetSize, indexSize]) {
    if (size > 8) {
      throw new TypeError('Unsafe HEIC iloc integer size');
    }
  }

  const itemCountBytes = header.version < 2 ? 2 : 4;
  assertReadable(cursor, itemCountBytes, box.end);
  const itemCount = itemCountBytes === 2 ? data.readUInt16BE(cursor) : data.readUInt32BE(cursor);
  cursor += itemCountBytes;
  if (itemCount <= 0 || itemCount > MAX_HEIC_BOXES) {
    throw new TypeError('Invalid HEIC iloc item count');
  }

  const locations: HeicItemLocation[] = [];
  let totalExtents = 0;
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const itemIdBytes = header.version < 2 ? 2 : 4;
    assertReadable(cursor, itemIdBytes, box.end);
    const itemId = itemIdBytes === 2 ? data.readUInt16BE(cursor) : data.readUInt32BE(cursor);
    cursor += itemIdBytes;

    let constructionMethod = 0;
    if (header.version > 0) {
      assertReadable(cursor, 2, box.end);
      const methodField = data.readUInt16BE(cursor);
      if ((methodField & 0xfff0) !== 0) {
        throw new TypeError('Invalid HEIC construction method field');
      }
      constructionMethod = methodField & 0x0f;
      cursor += 2;
    }

    assertReadable(cursor, 2, box.end);
    const dataReferenceIndex = data.readUInt16BE(cursor);
    cursor += 2;
    const baseOffset = readSizedUnsignedInteger(data, cursor, baseOffsetSize, box.end);
    cursor = baseOffset.cursor;

    assertReadable(cursor, 2, box.end);
    const extentCount = data.readUInt16BE(cursor);
    cursor += 2;
    totalExtents += extentCount;
    if (extentCount <= 0 || totalExtents > MAX_HEIC_BOXES) {
      throw new TypeError('Invalid HEIC extent count');
    }

    const extents: HeicByteRange[] = [];
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex += 1) {
      if (header.version > 0 && indexSize > 0) {
        cursor = readSizedUnsignedInteger(data, cursor, indexSize, box.end).cursor;
      }
      const extentOffset = readSizedUnsignedInteger(data, cursor, offsetSize, box.end);
      cursor = extentOffset.cursor;
      const extentLength = readSizedUnsignedInteger(data, cursor, lengthSize, box.end);
      cursor = extentLength.cursor;
      if (extentLength.value <= 0n) {
        throw new TypeError('HEIC extent is empty');
      }
      const start = baseOffset.value + extentOffset.value;
      const end = start + extentLength.value;
      if (
        start < 0n ||
        end <= start ||
        start > BigInt(Number.MAX_SAFE_INTEGER) ||
        end > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new TypeError('Unsafe HEIC extent bounds');
      }
      extents.push({ start: Number(start), end: Number(end) });
    }

    if (locations.some((location) => location.itemId === itemId)) {
      throw new TypeError('Duplicate HEIC item location');
    }
    locations.push({ itemId, constructionMethod, dataReferenceIndex, extents });
  }
  if (cursor !== box.end) {
    throw new TypeError('Unexpected trailing HEIC iloc data');
  }
  return locations;
}

function readHeicImageProperties(
  data: Buffer,
  iprpBox: IsoBox,
  primaryItemId: number,
  itemInfos: Map<number, HeicItemInfo>,
  budget: HeicParseBudget,
): Pick<HeicMeta, 'primaryDimensions' | 'allDimensions' | 'codedItems'> {
  const children = readIsoBoxes(data, iprpBox.payloadStart, iprpBox.end, budget);
  const ipco = requireSingleIsoBox(children, 'ipco');
  const ipmaBoxes = children.filter((box) => box.type === 'ipma');
  if (ipmaBoxes.length === 0) {
    throw new TypeError('HEIC property associations are missing');
  }

  const propertyBoxes = readIsoBoxes(data, ipco.payloadStart, ipco.end, budget);
  const dimensionsByProperty = new Map<number, ImageDimensions>();
  const hevcNalLengthByProperty = new Map<number, 1 | 2 | 3 | 4>();
  for (const [index, property] of propertyBoxes.entries()) {
    if (property.type === 'hvcC') {
      hevcNalLengthByProperty.set(index + 1, readHeicDecoderConfiguration(data, property));
    } else if (property.type === 'ispe') {
      const header = readFullBoxHeader(data, property);
      assertReadable(header.cursor, 8, property.end);
      dimensionsByProperty.set(index + 1, {
        width: data.readUInt32BE(header.cursor),
        height: data.readUInt32BE(header.cursor + 4),
      });
    }
  }
  if (dimensionsByProperty.size === 0) {
    throw new TypeError('HEIC ispe property is missing');
  }

  const associationsByItem = new Map<number, Set<number>>();
  for (const ipma of ipmaBoxes) {
    const associations = readHeicPropertyAssociations(data, ipma, propertyBoxes.length);
    for (const [itemId, propertyIndexes] of associations) {
      const merged = associationsByItem.get(itemId) ?? new Set<number>();
      for (const propertyIndex of propertyIndexes) {
        merged.add(propertyIndex);
      }
      associationsByItem.set(itemId, merged);
    }
  }
  const primaryPropertyIndexes = associationsByItem.get(primaryItemId) ?? new Set<number>();
  const primaryDimensions = [...primaryPropertyIndexes]
    .map((propertyIndex) => dimensionsByProperty.get(propertyIndex))
    .filter((dimension): dimension is ImageDimensions => Boolean(dimension));
  if (primaryDimensions.length === 0) {
    throw new TypeError('HEIC primary item has no associated ispe property');
  }

  const codedItemInfos = [...itemInfos.values()].filter(
    (itemInfo) => itemInfo.itemType === 'hvc1' || itemInfo.itemType === 'hev1',
  );
  if (codedItemInfos.length === 0) {
    throw new TypeError('HEIC has no HEVC-coded image item');
  }
  const codedItems = codedItemInfos.map((itemInfo): HeicCodedItem => {
    const propertyIndexes = associationsByItem.get(itemInfo.itemId) ?? new Set<number>();
    const configurationIndexes = [...propertyIndexes].filter((propertyIndex) =>
      hevcNalLengthByProperty.has(propertyIndex),
    );
    if (configurationIndexes.length !== 1) {
      throw new TypeError('HEIC coded item has no unambiguous hvcC property');
    }
    if (![...propertyIndexes].some((propertyIndex) => dimensionsByProperty.has(propertyIndex))) {
      throw new TypeError('HEIC coded item has no associated ispe property');
    }
    return {
      itemId: itemInfo.itemId,
      nalLengthSize: hevcNalLengthByProperty.get(configurationIndexes[0])!,
    };
  });

  return {
    primaryDimensions,
    allDimensions: [...dimensionsByProperty.values()],
    codedItems,
  };
}

function readHeicDecoderConfiguration(data: Buffer, box: IsoBox): 1 | 2 | 3 | 4 {
  assertReadable(box.payloadStart, 23, box.end);
  if (data[box.payloadStart] !== 1) {
    throw new TypeError('Invalid HEIC hvcC configuration version');
  }

  const lengthSize = ((data[box.payloadStart + 21] & 0x03) + 1) as 1 | 2 | 3 | 4;
  const arrayCount = data[box.payloadStart + 22];
  if (arrayCount > 64) {
    throw new TypeError('Invalid HEIC hvcC array count');
  }

  let cursor = box.payloadStart + 23;
  let nalCount = 0;
  for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
    assertReadable(cursor, 3, box.end);
    const arrayHeader = data[cursor];
    if ((arrayHeader & 0x40) !== 0) {
      throw new TypeError('Invalid HEIC hvcC array header');
    }
    const arrayNalType = arrayHeader & 0x3f;
    const arrayNalCount = data.readUInt16BE(cursor + 1);
    cursor += 3;
    for (let nalIndex = 0; nalIndex < arrayNalCount; nalIndex += 1) {
      assertReadable(cursor, 2, box.end);
      const nalLength = data.readUInt16BE(cursor);
      cursor += 2;
      assertReadable(cursor, nalLength, box.end);
      if (nalLength < 2 || ((data[cursor] >> 1) & 0x3f) !== arrayNalType) {
        throw new TypeError('Invalid HEIC hvcC NAL unit');
      }
      validateNalHeader('hevc', data, cursor, nalLength);
      cursor += nalLength;
      nalCount += 1;
      if (nalCount > MAX_CODEC_NAL_UNITS) {
        throw new TypeError('Excessive HEIC hvcC NAL units');
      }
    }
  }
  if (cursor !== box.end) {
    throw new TypeError('Unexpected trailing HEIC hvcC data');
  }
  return lengthSize;
}

function readHeicPropertyAssociations(
  data: Buffer,
  box: IsoBox,
  propertyCount: number,
): Map<number, number[]> {
  const header = readFullBoxHeader(data, box);
  if (header.version !== 0 && header.version !== 1) {
    throw new TypeError('Unsupported HEIC ipma version');
  }
  let cursor = header.cursor;
  assertReadable(cursor, 4, box.end);
  const entryCount = data.readUInt32BE(cursor);
  cursor += 4;
  if (entryCount > MAX_HEIC_BOXES) {
    throw new TypeError('Invalid HEIC ipma entry count');
  }

  const wideAssociation = (header.flags & 1) !== 0;
  const associations = new Map<number, number[]>();
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const itemIdBytes = header.version === 0 ? 2 : 4;
    assertReadable(cursor, itemIdBytes + 1, box.end);
    const itemId = itemIdBytes === 2 ? data.readUInt16BE(cursor) : data.readUInt32BE(cursor);
    cursor += itemIdBytes;
    const associationCount = data.readUInt8(cursor);
    cursor += 1;
    const propertyIndexes: number[] = [];
    for (let associationIndex = 0; associationIndex < associationCount; associationIndex += 1) {
      const associationBytes = wideAssociation ? 2 : 1;
      assertReadable(cursor, associationBytes, box.end);
      const raw = associationBytes === 2 ? data.readUInt16BE(cursor) : data.readUInt8(cursor);
      cursor += associationBytes;
      const propertyIndex = raw & (wideAssociation ? 0x7fff : 0x7f);
      if (propertyIndex > propertyCount) {
        throw new TypeError('HEIC property association is out of range');
      }
      if (propertyIndex > 0) {
        propertyIndexes.push(propertyIndex);
      }
    }
    associations.set(itemId, [...(associations.get(itemId) ?? []), ...propertyIndexes]);
  }
  if (cursor !== box.end) {
    throw new TypeError('Unexpected trailing HEIC ipma data');
  }
  return associations;
}

function validateHeicItemExtents(
  locations: HeicItemLocation[],
  mdatRanges: HeicByteRange[],
  idatRanges: HeicByteRange[],
): Map<number, HeicByteRange[]> {
  const resolvedRanges = new Map<number, HeicByteRange[]>();
  for (const location of locations) {
    if (location.dataReferenceIndex !== 0) {
      throw new TypeError('External HEIC data references are unsupported');
    }
    if (location.constructionMethod === 1) {
      if (idatRanges.length !== 1) {
        throw new TypeError('HEIC idat item data container is missing or duplicated');
      }
      const idatLength = idatRanges[0].end - idatRanges[0].start;
      for (const extent of location.extents) {
        if (extent.start < 0 || extent.end > idatLength) {
          throw new TypeError('HEIC item extent is outside its idat data container');
        }
      }
      resolvedRanges.set(
        location.itemId,
        location.extents.map((extent) => ({
          start: idatRanges[0].start + extent.start,
          end: idatRanges[0].start + extent.end,
        })),
      );
      continue;
    }
    if (location.constructionMethod !== 0 || mdatRanges.length === 0) {
      throw new TypeError('Unsupported or missing HEIC item data container');
    }
    for (const extent of location.extents) {
      if (!mdatRanges.some((range) => extent.start >= range.start && extent.end <= range.end)) {
        throw new TypeError('HEIC item extent is outside its data container');
      }
    }
    resolvedRanges.set(location.itemId, location.extents);
  }
  return resolvedRanges;
}

function validateHeicCodedItems(
  data: Buffer,
  codedItems: HeicCodedItem[],
  itemRanges: Map<number, HeicByteRange[]>,
): void {
  const budget = { bytes: 0, nalUnits: 0 };
  for (const codedItem of codedItems) {
    const ranges = itemRanges.get(codedItem.itemId);
    if (!ranges) {
      throw new TypeError('HEIC coded item has no data location');
    }
    const itemLength = ranges.reduce((total, range) => total + range.end - range.start, 0);
    if (!Number.isSafeInteger(itemLength) || itemLength <= 0) {
      throw new TypeError('Invalid HEIC coded item length');
    }
    budget.bytes += itemLength;
    if (!Number.isSafeInteger(budget.bytes) || budget.bytes > data.length) {
      throw new TypeError('HEIC coded item validation exceeds its payload budget');
    }

    const cursor = { rangeIndex: 0, rangeOffset: 0, position: 0, length: itemLength };
    let hasVclNal = false;
    while (cursor.position < cursor.length) {
      const nalLength = readHeicItemUnsigned(data, ranges, cursor, codedItem.nalLengthSize);
      if (nalLength < 3 || nalLength > cursor.length - cursor.position) {
        throw new TypeError('Invalid HEIC length-prefixed NAL unit boundary');
      }
      const firstHeaderByte = readHeicItemUnsigned(data, ranges, cursor, 1);
      const secondHeaderByte = readHeicItemUnsigned(data, ranges, cursor, 1);
      if ((firstHeaderByte & 0x80) !== 0 || (secondHeaderByte & 0x07) === 0) {
        throw new TypeError('Invalid HEIC HEVC NAL unit header');
      }
      hasVclNal ||= ((firstHeaderByte >> 1) & 0x3f) <= 31;
      skipHeicItemBytes(ranges, cursor, nalLength - 2);
      budget.nalUnits += 1;
      if (budget.nalUnits > MAX_CODEC_NAL_UNITS) {
        throw new TypeError('HEIC coded items contain too many NAL units');
      }
    }
    if (!hasVclNal) {
      throw new TypeError('HEIC coded item has no video coding NAL unit');
    }
  }
}

type HeicItemCursor = {
  rangeIndex: number;
  rangeOffset: number;
  position: number;
  length: number;
};

function readHeicItemUnsigned(
  data: Buffer,
  ranges: HeicByteRange[],
  cursor: HeicItemCursor,
  bytes: number,
): number {
  if (cursor.position + bytes > cursor.length) {
    throw new TypeError('Truncated HEIC coded item');
  }
  let value = 0;
  for (let index = 0; index < bytes; index += 1) {
    while (
      cursor.rangeIndex < ranges.length &&
      cursor.rangeOffset >= ranges[cursor.rangeIndex].end - ranges[cursor.rangeIndex].start
    ) {
      cursor.rangeIndex += 1;
      cursor.rangeOffset = 0;
    }
    const range = ranges[cursor.rangeIndex];
    if (!range) {
      throw new TypeError('Truncated HEIC coded item ranges');
    }
    value = value * 256 + data[range.start + cursor.rangeOffset];
    cursor.rangeOffset += 1;
    cursor.position += 1;
  }
  return value;
}

function skipHeicItemBytes(ranges: HeicByteRange[], cursor: HeicItemCursor, bytes: number): void {
  if (bytes < 0 || cursor.position + bytes > cursor.length) {
    throw new TypeError('Truncated HEIC coded item');
  }
  let remaining = bytes;
  while (remaining > 0) {
    const range = ranges[cursor.rangeIndex];
    if (!range) {
      throw new TypeError('Truncated HEIC coded item ranges');
    }
    const rangeRemaining = range.end - range.start - cursor.rangeOffset;
    if (rangeRemaining <= 0) {
      cursor.rangeIndex += 1;
      cursor.rangeOffset = 0;
      continue;
    }
    const chunkLength = Math.min(remaining, rangeRemaining);
    cursor.rangeOffset += chunkLength;
    cursor.position += chunkLength;
    remaining -= chunkLength;
  }
}

function readFullBoxHeader(
  data: Buffer,
  box: IsoBox,
): { version: number; flags: number; cursor: number } {
  assertReadable(box.payloadStart, 4, box.end);
  return {
    version: data.readUInt8(box.payloadStart),
    flags: data.readUIntBE(box.payloadStart + 1, 3),
    cursor: box.payloadStart + 4,
  };
}

function readSizedUnsignedInteger(
  data: Buffer,
  cursor: number,
  size: number,
  end: number,
): { value: bigint; cursor: number } {
  assertReadable(cursor, size, end);
  let value = 0n;
  for (let index = 0; index < size; index += 1) {
    value = (value << 8n) | BigInt(data.readUInt8(cursor + index));
  }
  return { value, cursor: cursor + size };
}

function assertReadable(cursor: number, bytes: number, end: number): void {
  if (
    !Number.isSafeInteger(cursor) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    cursor < 0 ||
    cursor + bytes > end
  ) {
    throw new TypeError('Truncated HEIC box payload');
  }
}

function requireSingleIsoBox(boxes: IsoBox[], type: string): IsoBox {
  const matches = boxes.filter((box) => box.type === type);
  if (matches.length !== 1) {
    throw new TypeError(`HEIC ${type} box is missing or duplicated`);
  }
  return matches[0];
}

function readIsoBoxes(data: Buffer, start: number, end: number, budget: HeicParseBudget): IsoBox[] {
  const boxes: IsoBox[] = [];
  forEachIsoBox(data, start, end, budget, (box) => boxes.push(box));
  return boxes;
}

function forEachIsoBox(
  data: Buffer,
  start: number,
  end: number,
  budget: HeicParseBudget,
  visit: (box: IsoBox) => void,
): void {
  let offset = start;
  while (offset < end) {
    const box = readIsoBox(data, offset, end, budget);
    visit(box);
    offset = box.end;
  }
}

function readIsoBox(
  data: Buffer,
  offset: number,
  containerEnd: number,
  budget: HeicParseBudget,
): IsoBox {
  budget.boxes += 1;
  if (budget.boxes > MAX_HEIC_BOXES || offset < 0 || offset + 8 > containerEnd) {
    throw new TypeError('Invalid or excessive HEIC boxes');
  }

  const size32 = data.readUInt32BE(offset);
  const type = data.toString('latin1', offset + 4, offset + 8);
  let headerBytes = 8;
  let size: number;

  if (size32 === 0) {
    size = containerEnd - offset;
  } else if (size32 === 1) {
    if (offset + 16 > containerEnd) {
      throw new TypeError('Truncated HEIC large-size box');
    }
    const largeSize = data.readBigUInt64BE(offset + 8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError('Unsafe HEIC box size');
    }
    headerBytes = 16;
    size = Number(largeSize);
  } else {
    size = size32;
  }

  const end = offset + size;
  if (size < headerBytes || !Number.isSafeInteger(end) || end <= offset || end > containerEnd) {
    throw new TypeError('Invalid HEIC box bounds');
  }

  return { type, start: offset, payloadStart: offset + headerBytes, end };
}

function assertImageDimensions(width: number, height: number, detectedExtension: string): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
      { detectedExtension },
    );
  }
  if (width > MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX || height > MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX) {
    throw new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED,
      'image',
      { detectedExtension },
    );
  }
}

function isSharpPixelLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('pixel limit');
}

function resolveValidationErrorMessage(
  code: MaxMediaUploadValidationErrorCode,
  uploadType: 'image' | 'video',
): string {
  if (code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED) {
    return 'MAX animated image upload exceeds the bounded decode budget';
  }
  if (code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED) {
    return `MAX image upload dimensions exceed ${MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX}x${MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX}`;
  }
  if (code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT) {
    return `MAX ${uploadType} upload format is unsupported`;
  }
  return `MAX ${uploadType} upload payload is invalid`;
}

function resolveValidationErrorPublicMessage(
  code: MaxMediaUploadValidationErrorCode,
  uploadType: 'image' | 'video',
): string {
  if (code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED) {
    return MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGES.IMAGE_DECODE_BUDGET_EXCEEDED;
  }
  if (code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED) {
    return MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGES.IMAGE_DIMENSIONS_EXCEEDED;
  }
  if (code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT) {
    return uploadType === 'image'
      ? MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGES.UNSUPPORTED_IMAGE
      : MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGES.UNSUPPORTED_VIDEO;
  }
  return MAX_MEDIA_UPLOAD_VALIDATION_PUBLIC_MESSAGES.INVALID_PAYLOAD;
}
