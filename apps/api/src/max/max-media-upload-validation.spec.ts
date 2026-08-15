import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import {
  TINY_VALID_HEIC,
  TINY_VALID_MKV,
  TINY_VALID_MOV,
  TINY_VALID_MP4,
  TINY_VALID_WEBM,
} from '../../test/fixtures/max-media';
import {
  MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX,
  MAX_MEDIA_UPLOAD_VALIDATION_TEST_BOUNDARY,
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
  validateMaxMediaUploadPayload,
} from './max-media-upload-validation';

function isoBox(type: string, payload: Buffer, sizeOverride?: number): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(sizeOverride ?? box.length, 0);
  box.write(type, 4, 4, 'latin1');
  payload.copy(box, 8);
  return box;
}

function extractIsoBox(source: Buffer, type: string): Buffer {
  const typeOffset = source.indexOf(Buffer.from(type, 'latin1'));
  if (typeOffset < 4) {
    throw new Error(`Fixture has no ${type} box`);
  }
  const boxOffset = typeOffset - 4;
  return source.subarray(boxOffset, boxOffset + source.readUInt32BE(boxOffset));
}

function buildHeicMetadataOnly(width: number, height: number): Buffer {
  const ispePayload = Buffer.alloc(12);
  ispePayload.writeUInt32BE(width, 4);
  ispePayload.writeUInt32BE(height, 8);
  const ipco = isoBox('ipco', isoBox('ispe', ispePayload));
  const meta = isoBox('meta', Buffer.concat([Buffer.alloc(4), isoBox('iprp', ipco)]));
  const ftyp = isoBox(
    'ftyp',
    Buffer.concat([Buffer.from('heic'), Buffer.alloc(4), Buffer.from('mif1heic')]),
  );
  return Buffer.concat([ftyp, meta]);
}

function buildIdatHeic(width: number, height: number, extentOffset = 0): Buffer {
  const fullBox = (version: number, payload: Buffer) =>
    Buffer.concat([Buffer.from([version, 0, 0, 0]), payload]);
  const pitmPayload = Buffer.alloc(2);
  pitmPayload.writeUInt16BE(1);
  const pitm = isoBox('pitm', fullBox(0, pitmPayload));

  const ilocPayload = Buffer.alloc(20);
  ilocPayload[0] = 0x44;
  ilocPayload.writeUInt16BE(1, 2);
  ilocPayload.writeUInt16BE(1, 4);
  ilocPayload.writeUInt16BE(1, 6);
  ilocPayload.writeUInt16BE(0, 8);
  ilocPayload.writeUInt16BE(1, 10);
  ilocPayload.writeUInt32BE(extentOffset, 12);
  ilocPayload.writeUInt32BE(4, 16);
  const iloc = isoBox('iloc', fullBox(1, ilocPayload));

  const infePayload = Buffer.alloc(8);
  infePayload.writeUInt16BE(1);
  infePayload.write('hvc1', 4, 4, 'latin1');
  const infe = isoBox('infe', fullBox(2, infePayload));
  const iinfCount = Buffer.alloc(2);
  iinfCount.writeUInt16BE(1);
  const iinf = isoBox('iinf', fullBox(0, Buffer.concat([iinfCount, infe])));

  const ispePayload = Buffer.alloc(12);
  ispePayload.writeUInt32BE(width, 4);
  ispePayload.writeUInt32BE(height, 8);
  const ipco = isoBox(
    'ipco',
    Buffer.concat([extractIsoBox(TINY_VALID_HEIC, 'hvcC'), isoBox('ispe', ispePayload)]),
  );
  const ipmaPayload = Buffer.alloc(9);
  ipmaPayload.writeUInt32BE(1);
  ipmaPayload.writeUInt16BE(1, 4);
  ipmaPayload[6] = 2;
  ipmaPayload[7] = 0x81;
  ipmaPayload[8] = 0x02;
  const ipma = isoBox('ipma', fullBox(0, ipmaPayload));
  const iprp = isoBox('iprp', Buffer.concat([ipco, ipma]));
  const idat = isoBox('idat', Buffer.from([1, 2, 3, 4]));
  const meta = isoBox('meta', fullBox(0, Buffer.concat([pitm, iloc, iinf, iprp, idat])));
  const ftyp = isoBox(
    'ftyp',
    Buffer.concat([Buffer.from('heic'), Buffer.alloc(4), Buffer.from('mif1heic')]),
  );
  return Buffer.concat([ftyp, meta]);
}

function buildBmp(width: number, height: number, bitsPerPixel = 24): Buffer {
  const rowBytes = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const pixelBytes = rowBytes * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write('BM', 0, 2, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(bitsPerPixel, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  return buffer;
}

function buildPalettedBmp(width = 4, height = 2, paletteEntries = 2): Buffer {
  const bitsPerPixel = 8;
  const paletteBytes = paletteEntries * 4;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const pixelBytes = rowBytes * height;
  const pixelOffset = 54 + paletteBytes;
  const buffer = Buffer.alloc(pixelOffset + pixelBytes);
  buffer.write('BM', 0, 2, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(pixelOffset, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(bitsPerPixel, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeUInt32LE(paletteEntries, 46);
  if (paletteEntries > 1) {
    buffer.set([0, 0, 0, 0, 255, 255, 255, 0], 54);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        buffer[pixelOffset + row * rowBytes + column] = (row + column) % paletteEntries;
      }
    }
  }
  return buffer;
}

function buildExternalBitfieldsBmp(width = 2, height = 1): Buffer {
  const bitsPerPixel = 32;
  const maskBytes = 12;
  const pixelOffset = 54 + maskBytes;
  const rowBytes = width * 4;
  const pixelBytes = rowBytes * height;
  const buffer = Buffer.alloc(pixelOffset + pixelBytes);
  buffer.write('BM', 0, 2, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(pixelOffset, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(bitsPerPixel, 28);
  buffer.writeUInt32LE(3, 30);
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeUInt32LE(0x00ff0000, 54);
  buffer.writeUInt32LE(0x0000ff00, 58);
  buffer.writeUInt32LE(0x000000ff, 62);
  buffer.fill(0x55, pixelOffset);
  return buffer;
}

function withHeicDimensions(source: Buffer, width: number, height: number): Buffer {
  const data = Buffer.from(source);
  const ispeTypeOffset = data.indexOf(Buffer.from('ispe'));
  if (ispeTypeOffset < 0) {
    throw new Error('HEIC fixture has no ispe box');
  }
  data.writeUInt32BE(width, ispeTypeOffset + 8);
  data.writeUInt32BE(height, ispeTypeOffset + 12);
  return data;
}

function appendHeicImageProperty(source: Buffer, width: number, height: number): Buffer {
  const findBoxStart = (type: string) => {
    const typeOffset = source.indexOf(Buffer.from(type));
    if (typeOffset < 4) {
      throw new Error(`HEIC fixture has no ${type} box`);
    }
    return typeOffset - 4;
  };
  const metaStart = findBoxStart('meta');
  const iprpStart = findBoxStart('iprp');
  const ipcoStart = findBoxStart('ipco');
  const ilocTypeOffset = findBoxStart('iloc') + 4;
  const insertionOffset = ipcoStart + source.readUInt32BE(ipcoStart);
  const payload = Buffer.alloc(12);
  payload.writeUInt32BE(width, 4);
  payload.writeUInt32BE(height, 8);
  const property = isoBox('ispe', payload);
  const result = Buffer.concat([
    source.subarray(0, insertionOffset),
    property,
    source.subarray(insertionOffset),
  ]);
  for (const boxStart of [metaStart, iprpStart, ipcoStart]) {
    result.writeUInt32BE(source.readUInt32BE(boxStart) + property.length, boxStart);
  }
  const extentOffsetPosition = ilocTypeOffset + 22;
  result.writeUInt32BE(
    source.readUInt32BE(extentOffsetPosition) + property.length,
    extentOffsetPosition,
  );
  return result;
}

async function buildSharpImage(
  format: 'jpeg' | 'png' | 'gif' | 'tiff' | 'webp' | 'avif',
  width = 3,
  height = 2,
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 40, b: 60 } },
  });
  return image[format]().toBuffer();
}

async function buildAnimatedGif(width = 3, pageHeight = 2): Promise<Buffer> {
  const pages = 2;
  const frameBytes = width * pageHeight * 3;
  const input = Buffer.alloc(frameBytes * pages);
  input.fill(32, 0, frameBytes);
  input.fill(224, frameBytes);
  return sharp(input, {
    raw: { width, height: pageHeight * pages, channels: 3, pageHeight },
  })
    .gif({ delay: [100, 100], loop: 0, keepDuplicateFrames: true })
    .toBuffer();
}

async function buildMultiPageTiff(width = 5, pageHeight = 4, pages = 3): Promise<Buffer> {
  const input = Buffer.alloc(width * pageHeight * pages * 3, 96);
  return sharp(input, {
    raw: { width, height: pageHeight * pages, channels: 3, pageHeight },
  })
    .tiff()
    .toBuffer();
}

function zeroEncodedPacket(source: Buffer, marker: Buffer, packetLength: number): Buffer {
  const packetOffset = source.indexOf(marker);
  if (packetOffset < 0 || packetOffset + packetLength > source.length) {
    throw new Error('Video fixture packet marker is missing or truncated');
  }
  const result = Buffer.from(source);
  result.fill(0, packetOffset, packetOffset + packetLength);
  return result;
}

function expectValidationCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(MaxMediaUploadValidationError);
  expect(error).toMatchObject({ code, name: 'MaxMediaUploadValidationError' });
}

describe('MAX media upload validation', () => {
  it('marks deterministic validation failures as terminal pre-dispatch errors', async () => {
    const error = await validateMaxMediaUploadPayload('image', Buffer.from('not an image')).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MaxMediaUploadValidationError);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ preDispatch: true, retryable: false });
  });

  it.each([
    ['jpeg', 'jpeg', 'jpg', 'image/jpeg'],
    ['png', 'png', 'png', 'image/png'],
    ['gif', 'gif', 'gif', 'image/gif'],
    ['tiff', 'tiff', 'tiff', 'image/tiff'],
  ] as const)(
    'accepts supported %s images from their bytes',
    async (input, format, extension, mimeType) => {
      const result = await validateMaxMediaUploadPayload('image', await buildSharpImage(input));
      expect(result).toEqual({
        uploadType: 'image',
        format,
        extension,
        mimeType,
        width: 3,
        height: 2,
      });
    },
  );

  it.each([
    ['JPEG', 'jpeg', 1],
    ['PNG', 'png', 16],
    ['GIF', 'gif', 1],
    ['TIFF', 'tiff', 1],
  ] as const)('rejects truncated %s pixel streams', async (_label, format, cutBytes) => {
    const complete = await buildSharpImage(format, 64, 64);
    await expect(
      validateMaxMediaUploadPayload('image', complete.subarray(0, -cutBytes)),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it('uses the logical GIF page height and accepts zero padding after its trailer', async () => {
    const animated = await buildAnimatedGif(5, 3);
    await expect(
      validateMaxMediaUploadPayload('image', Buffer.concat([animated, Buffer.alloc(16)])),
    ).resolves.toMatchObject({
      format: 'gif',
      width: 5,
      height: 3,
    });
    await expect(
      validateMaxMediaUploadPayload('image', animated.subarray(0, -1)),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it('rejects an animated GIF whose aggregate decoded frames exceed the bounded pixel budget', async () => {
    const animated = Buffer.from(await buildAnimatedGif(5, 3));
    animated.writeUInt16LE(MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX, 6);
    animated.writeUInt16LE(MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX, 8);

    await expect(validateMaxMediaUploadPayload('image', animated)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED,
      publicMessage: 'Анимированное изображение слишком большое или содержит слишком много кадров.',
    });
  });

  it('keeps the sharp decode budget aggregate across every TIFF page', async () => {
    const width = 5;
    const pageHeight = 4;
    const pages = 3;
    const multiPage = await buildMultiPageTiff(width, pageHeight, pages);

    await expect(
      sharp(multiPage, {
        animated: true,
        limitInputPixels: width * pageHeight * pages - 1,
      }).metadata(),
    ).rejects.toThrow(/pixel limit/i);
  });

  it('checks multi-page TIFF dimensions per page rather than by aggregate stack height', async () => {
    const pageHeight = MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX;
    const multiPage = await buildMultiPageTiff(1, pageHeight, 2);

    await expect(validateMaxMediaUploadPayload('image', multiPage)).resolves.toMatchObject({
      format: 'tiff',
      width: 1,
      height: pageHeight,
    });
  });

  it('accepts complete bounded BMP and HEIC payloads', async () => {
    await expect(validateMaxMediaUploadPayload('image', buildBmp(7, 5))).resolves.toMatchObject({
      format: 'bmp',
      extension: 'bmp',
      mimeType: 'image/bmp',
      width: 7,
      height: 5,
    });
    await expect(validateMaxMediaUploadPayload('image', TINY_VALID_HEIC)).resolves.toMatchObject({
      format: 'heic',
      extension: 'heic',
      mimeType: 'image/heic',
      width: 64,
      height: 64,
    });
  });

  it('accepts bounded paletted and external-bitfield BMP layouts', async () => {
    await expect(validateMaxMediaUploadPayload('image', buildPalettedBmp())).resolves.toMatchObject(
      {
        format: 'bmp',
        width: 4,
        height: 2,
      },
    );
    await expect(
      validateMaxMediaUploadPayload('image', buildExternalBitfieldsBmp()),
    ).resolves.toMatchObject({
      format: 'bmp',
      width: 2,
      height: 1,
    });
  });

  it('yields the event loop while scanning a large reduced BMP palette', async () => {
    const image = buildPalettedBmp(2_048, 256, 1);
    let eventLoopYielded = false;
    setImmediate(() => {
      eventLoopYielded = true;
    });

    await expect(validateMaxMediaUploadPayload('image', image)).resolves.toMatchObject({
      format: 'bmp',
      width: 2_048,
      height: 256,
    });
    expect(eventLoopYielded).toBe(true);
  });

  it('rejects out-of-range palette indices and overlapping BMP bitfield masks', async () => {
    const invalidPalette = buildPalettedBmp();
    invalidPalette[invalidPalette.readUInt32LE(10)] = 2;
    await expect(validateMaxMediaUploadPayload('image', invalidPalette)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });

    const overlappingMasks = buildExternalBitfieldsBmp();
    overlappingMasks.writeUInt32LE(0x00ff0000, 58);
    await expect(validateMaxMediaUploadPayload('image', overlappingMasks)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it('rejects a BMP whose declared dimensions exceed its pixel payload', async () => {
    const truncated = buildBmp(7, 5).subarray(0, -1);
    truncated.writeUInt32LE(truncated.length, 2);
    await expect(validateMaxMediaUploadPayload('image', truncated)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it.each([
    ['RLE8', 1, 8],
    ['RLE4', 2, 4],
  ] as const)('rejects %s BMP payloads fail-closed', async (_label, compression, depth) => {
    const compressed = buildBmp(4, 1, depth);
    compressed.writeUInt32LE(compression, 30);
    await expect(validateMaxMediaUploadPayload('image', compressed)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it.each([
    ['paletted', buildBmp(4, 1, 8)],
    [
      'external bitfield masks',
      (() => {
        const bitfields = buildBmp(4, 1, 32);
        bitfields.writeUInt32LE(3, 30);
        return bitfields;
      })(),
    ],
  ])('rejects malformed %s BMP layouts', async (_label, bytes) => {
    await expect(validateMaxMediaUploadPayload('image', bytes)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it('accepts the exact image dimension boundary', async () => {
    const boundary = await buildSharpImage('png', MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX, 1);
    await expect(validateMaxMediaUploadPayload('image', boundary)).resolves.toMatchObject({
      width: MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX,
      height: 1,
    });
  });

  it.each([
    ['PNG', () => buildSharpImage('png', MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX + 1, 1)],
    ['BMP', async () => buildBmp(MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX + 1, 1)],
    [
      'HEIC',
      async () => withHeicDimensions(TINY_VALID_HEIC, 1, MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX + 1),
    ],
  ] as const)('rejects %s when either side exceeds the documented limit', async (_label, build) => {
    await expect(validateMaxMediaUploadPayload('image', await build())).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED,
    });
  });

  it('rejects an oversized secondary HEIC image property', async () => {
    await expect(
      validateMaxMediaUploadPayload(
        'image',
        appendHeicImageProperty(TINY_VALID_HEIC, MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX + 1, 1),
      ),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED,
    });
  });

  it.each([
    ['webp', () => buildSharpImage('webp')],
    ['avif', () => buildSharpImage('avif')],
  ] as const)('rejects MAX-unsupported %s images', async (_label, build) => {
    await expect(validateMaxMediaUploadPayload('image', await build())).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT,
    });
  });

  it.each([
    ['mp4', TINY_VALID_MP4, 'video/mp4'],
    ['mov', TINY_VALID_MOV, 'video/quicktime'],
    ['mkv', TINY_VALID_MKV, 'video/x-matroska'],
    ['webm', TINY_VALID_WEBM, 'video/webm'],
  ] as const)('accepts supported %s video containers', async (format, bytes, mimeType) => {
    await expect(validateMaxMediaUploadPayload('video', bytes)).resolves.toEqual({
      uploadType: 'video',
      format,
      extension: format,
      mimeType,
    });
  });

  it.each([
    ['AVI', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')])],
    ['M4V', isoBox('ftyp', Buffer.concat([Buffer.from('M4V '), Buffer.alloc(4)]))],
  ])('rejects MAX-unsupported %s video containers', async (_label, bytes) => {
    await expect(validateMaxMediaUploadPayload('video', bytes)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT,
    });
  });

  it.each([
    ['MP4 header only', isoBox('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)]))],
    ['truncated MP4', TINY_VALID_MP4.subarray(0, -16)],
    ['truncated MOV', TINY_VALID_MOV.subarray(0, -16)],
    ['truncated MKV', TINY_VALID_MKV.subarray(0, -32)],
    ['truncated WEBM', TINY_VALID_WEBM.subarray(0, -32)],
  ])('rejects a structurally incomplete %s video payload', async (_label, bytes) => {
    await expect(validateMaxMediaUploadPayload('video', bytes)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it.each([
    ['MP4', zeroEncodedPacket(TINY_VALID_MP4, Buffer.from('000002710605ffff', 'hex'), 643)],
    ['MOV', zeroEncodedPacket(TINY_VALID_MOV, Buffer.from('000002710605ffff', 'hex'), 643)],
    ['MKV', zeroEncodedPacket(TINY_VALID_MKV, Buffer.from('000002710605ffff', 'hex'), 643)],
    ['WEBM', zeroEncodedPacket(TINY_VALID_WEBM, Buffer.from('1002009d012a', 'hex'), 31)],
  ])('rejects a %s container whose encoded video packet was zeroed', async (_label, bytes) => {
    await expect(validateMaxMediaUploadPayload('video', bytes)).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it.each(['vp9', 'av1'])('yields while rejecting a large all-zero %s packet', async (codec) => {
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });

    await expect(
      MAX_MEDIA_UPLOAD_VALIDATION_TEST_BOUNDARY.validateEncodedVideoPacket(
        codec,
        {},
        Buffer.alloc(2 * 1024 * 1024),
      ),
    ).rejects.toThrow(`${codec.toUpperCase()} packet contains no encoded data`);
    expect(yielded).toBe(true);
  });

  it('yields while traversing a large Annex-B packet without weakening validation', async () => {
    const packet = Buffer.concat([
      Buffer.from([0, 0, 0, 1, 0x65, 0x80]),
      Buffer.alloc(2 * 1024 * 1024),
    ]);
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });

    await expect(
      MAX_MEDIA_UPLOAD_VALIDATION_TEST_BOUNDARY.validateEncodedVideoPacket('avc', {}, packet),
    ).resolves.toBeUndefined();
    expect(yielded).toBe(true);
    await expect(
      MAX_MEDIA_UPLOAD_VALIDATION_TEST_BOUNDARY.validateEncodedVideoPacket(
        'avc',
        {},
        Buffer.concat([Buffer.from([1]), packet]),
      ),
    ).rejects.toThrow('Annex-B packet has no leading start code');
  });

  it('rejects malformed payloads with a stable structured error', async () => {
    let error: unknown;
    try {
      await validateMaxMediaUploadPayload('image', Buffer.from('ffd8ff00', 'hex'));
    } catch (caught: unknown) {
      error = caught;
    }
    expectValidationCode(error, MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD);
    expect(error).toMatchObject({
      uploadType: 'image',
      detectedExtension: null,
      publicMessage: 'Не удалось распознать файл. Выберите исправный файл поддерживаемого формата.',
      retryable: false,
      preDispatch: true,
    });
  });

  it('bounds malformed HEIC boxes without looping or unsafe offsets', async () => {
    const ftyp = isoBox(
      'ftyp',
      Buffer.concat([Buffer.from('heic'), Buffer.alloc(4), Buffer.from('mif1heic')]),
    );
    const zeroSizedUnknownBox = isoBox('free', Buffer.alloc(8), 0);
    await expect(
      validateMaxMediaUploadPayload('image', Buffer.concat([ftyp, zeroSizedUnknownBox])),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });

    const unsafeLargeBox = Buffer.alloc(16);
    unsafeLargeBox.writeUInt32BE(1, 0);
    unsafeLargeBox.write('meta', 4, 4, 'latin1');
    unsafeLargeBox.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
    await expect(
      validateMaxMediaUploadPayload('image', Buffer.concat([ftyp, unsafeLargeBox])),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it('rejects HEIC metadata without primary-item data and truncated item extents', async () => {
    await expect(
      validateMaxMediaUploadPayload('image', buildHeicMetadataOnly(9, 6)),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
    await expect(
      validateMaxMediaUploadPayload('image', TINY_VALID_HEIC.subarray(0, -1)),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it('rejects fabricated HEVC bytes in iloc construction method 1 extents', async () => {
    await expect(validateMaxMediaUploadPayload('image', buildIdatHeic(9, 6))).rejects.toMatchObject(
      {
        code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      },
    );
    await expect(
      validateMaxMediaUploadPayload('image', buildIdatHeic(9, 6, 1)),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });

  it('rejects HEIC metadata outside the bounded inspection window', async () => {
    const ftyp = isoBox(
      'ftyp',
      Buffer.concat([Buffer.from('heic'), Buffer.alloc(4), Buffer.from('mif1heic')]),
    );
    const padding = isoBox('free', Buffer.alloc(4 * 1024 * 1024));
    await expect(
      validateMaxMediaUploadPayload(
        'image',
        Buffer.concat([ftyp, padding, buildHeicMetadataOnly(1, 1)]),
      ),
    ).rejects.toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
    });
  });
});
