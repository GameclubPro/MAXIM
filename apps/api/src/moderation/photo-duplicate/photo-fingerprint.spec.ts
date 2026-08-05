import sharp from 'sharp';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  PhotoFingerprintRejectedError,
  PhotoFingerprintService,
  createPhotoAlbumFingerprint,
  createPlatformPhotoAlbumHash,
  hammingDistanceHex,
  matchPhotoAlbums,
  type PhotoFingerprint,
} from './photo-fingerprint';

function fingerprintFixture(params: {
  canonicalHash: string;
  pdqHash: string;
  pdqQuality?: number;
}): PhotoFingerprint {
  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    canonicalHash: params.canonicalHash,
    pdqHash: params.pdqHash,
    pdqQuality: params.pdqQuality ?? 80,
  };
}

async function multiPageImage(format: 'gif' | 'webp' | 'tiff'): Promise<Buffer> {
  const width = 8;
  const pageHeight = 6;
  const pages = 2;
  const frameBytes = width * pageHeight * 3;
  const input = Buffer.alloc(frameBytes * pages);
  input.fill(32, 0, frameBytes);
  input.fill(224, frameBytes);
  const image = sharp(input, {
    raw: { width, height: pageHeight * pages, channels: 3, pageHeight },
  });

  if (format === 'gif') {
    return image.gif({ delay: [100, 100], loop: 0, keepDuplicateFrames: true }).toBuffer();
  }
  if (format === 'webp') {
    return image.webp({ delay: [100, 100], loop: 0 }).toBuffer();
  }
  return image.tiff({ compression: 'deflate' }).toBuffer();
}

async function patternedPhoto(): Promise<Buffer> {
  const width = 320;
  const height = 240;
  const input = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const checker = (Math.floor(x / 32) + Math.floor(y / 24)) % 2 === 0 ? 36 : -24;
      input[offset] = Math.max(0, Math.min(255, (x * 3 + y + checker) % 256));
      input[offset + 1] = Math.max(0, Math.min(255, (x + y * 2 + 80 - checker) % 256));
      input[offset + 2] = Math.max(0, Math.min(255, (x * 2 + y * 3 + 40) % 256));
    }
  }
  return sharp(input, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('PhotoFingerprintService', () => {
  it('normalizes an encoded image and initializes PDQ from the local Node package', async () => {
    const input = Buffer.alloc(96 * 64 * 3);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const offset = (y * 96 + x) * 3;
        input[offset] = (x * 13 + y * 3) % 256;
        input[offset + 1] = (x * 5 + y * 17) % 256;
        input[offset + 2] = (x * 19 + y * 7) % 256;
      }
    }
    const png = await sharp(input, { raw: { width: 96, height: 64, channels: 3 } })
      .png()
      .toBuffer();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network access is forbidden in the PDQ smoke test'));

    try {
      const fingerprint = await new PhotoFingerprintService().fingerprint(png);

      expect(fingerprint).toEqual({
        algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        canonicalHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        pdqHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        pdqQuality: expect.any(Number),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('matches real recompression and bounded visual edits with the advertised presets', async () => {
    const original = await patternedPhoto();
    const recompressed = await sharp(original)
      .resize({ width: 220 })
      .jpeg({ quality: 72 })
      .toBuffer();
    const lightlyEdited = await sharp(original)
      .extract({ left: 4, top: 3, width: 312, height: 234 })
      .modulate({ brightness: 1.02, saturation: 0.96, hue: 2 })
      .jpeg({ quality: 78 })
      .toBuffer();
    const service = new PhotoFingerprintService();
    const [baseFingerprint, recompressedFingerprint, editedFingerprint] = await Promise.all([
      service.fingerprint(original, { expectedFormat: 'png' }),
      service.fingerprint(recompressed, { expectedFormat: 'jpeg' }),
      service.fingerprint(lightlyEdited, { expectedFormat: 'jpeg' }),
    ]);
    const baseAlbum = createPhotoAlbumFingerprint([baseFingerprint]);

    expect(
      matchPhotoAlbums(baseAlbum, createPhotoAlbumFingerprint([recompressedFingerprint]), {
        preset: 'SAME_IMAGE',
      }),
    ).toEqual(
      expect.objectContaining({
        matched: true,
        usedPerceptualHash: true,
      }),
    );
    expect(
      matchPhotoAlbums(baseAlbum, createPhotoAlbumFingerprint([editedFingerprint]), {
        preset: 'MINOR_EDITS',
      }),
    ).toEqual(
      expect.objectContaining({
        matched: true,
        usedPerceptualHash: true,
      }),
    );
  });

  it('rejects oversized encoded input before decoding', async () => {
    await expect(
      new PhotoFingerprintService({ maxInputBytes: 4 }).fingerprint(Buffer.alloc(5)),
    ).rejects.toThrow('byte length');
  });

  it('rejects when decoder output does not match the format detected from magic bytes', async () => {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#447799' },
    })
      .png()
      .toBuffer();

    await expect(
      new PhotoFingerprintService().fingerprint(png, { expectedFormat: 'jpeg' }),
    ).rejects.toMatchObject<Partial<PhotoFingerprintRejectedError>>({
      reason: 'unsupported_image',
    });
  });

  it.each(['gif', 'webp', 'tiff'] as const)(
    'rejects multi-frame %s instead of fingerprinting only its first frame',
    async (format) => {
      const encoded = await multiPageImage(format);
      const budget = new PhotoFingerprintService().createAlbumDecodeBudget();

      await expect(
        new PhotoFingerprintService().fingerprint(encoded, {
          albumBudget: budget,
          expectedFormat: format,
        }),
      ).rejects.toMatchObject<Partial<PhotoFingerprintRejectedError>>({
        reason: 'unsupported_multi_frame',
      });
      expect(budget.usage()).toMatchObject({ encodedBytes: 0, pixels: 0 });
    },
  );

  it('enforces one cumulative pixel budget across image decodes in an album', async () => {
    const encoded = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#447799' },
    })
      .png()
      .toBuffer();
    const service = new PhotoFingerprintService({
      maxInputBytes: 1_048_576,
      maxInputPixels: 1_000,
      maxAlbumInputBytes: 1_048_576,
      maxAlbumInputPixels: 150,
    });
    const budget = service.createAlbumDecodeBudget();

    await expect(
      service.fingerprint(encoded, { albumBudget: budget, expectedFormat: 'png' }),
    ).resolves.toEqual(expect.objectContaining({ algorithmVersion: 'sharp-rgb512-pdq-v2' }));
    await expect(
      service.fingerprint(encoded, { albumBudget: budget, expectedFormat: 'png' }),
    ).rejects.toMatchObject<Partial<PhotoFingerprintRejectedError>>({
      reason: 'album_decode_budget_exceeded',
    });
    expect(budget.usage()).toMatchObject({ pixels: 100, maxPixels: 150 });
  });

  it('retries a failed local PDQ initialization and exposes it as a startup hook', async () => {
    jest.resetModules();
    const init = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('broken wasm package'))
      .mockResolvedValueOnce(undefined);
    jest.doMock('pdq-wasm', () => ({
      PDQ: {
        init,
        hash: jest.fn(),
        toHex: jest.fn(),
      },
    }));

    try {
      const isolatedModule = await import('./photo-fingerprint');
      const service = new isolatedModule.PhotoFingerprintService();

      await expect(service.onModuleInit()).rejects.toThrow('broken wasm package');
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(init).toHaveBeenCalledTimes(2);
    } finally {
      jest.dontMock('pdq-wasm');
    }
  });
});

describe('photo album fingerprints', () => {
  const zero = '0'.repeat(64);
  const oneBit = `${'0'.repeat(63)}1`;
  const far = 'f'.repeat(64);
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  it('builds the same identity for unordered platform-id multisets', () => {
    expect(createPlatformPhotoAlbumHash(['photo-b', 'photo-a'])).toBe(
      createPlatformPhotoAlbumHash(['photo-a', 'photo-b']),
    );
    expect(createPlatformPhotoAlbumHash(['photo-a', null])).toBeNull();
    expect(createPlatformPhotoAlbumHash(['photo-a', 'photo-a'])).not.toBe(
      createPlatformPhotoAlbumHash(['photo-a']),
    );
  });

  it('builds the same canonical album hash independent of image order', () => {
    const a = fingerprintFixture({ canonicalHash: hashA, pdqHash: zero });
    const b = fingerprintFixture({ canonicalHash: hashB, pdqHash: far });

    expect(createPhotoAlbumFingerprint([a, b]).albumHash).toBe(
      createPhotoAlbumFingerprint([b, a]).albumHash,
    );
  });

  it('matches only a complete unordered multiset', () => {
    const left = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashA, pdqHash: zero }),
      fingerprintFixture({ canonicalHash: hashB, pdqHash: far }),
    ]);
    const reordered = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: 'c'.repeat(64), pdqHash: far }),
      fingerprintFixture({ canonicalHash: 'd'.repeat(64), pdqHash: oneBit }),
    ]);
    const partial = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: 'c'.repeat(64), pdqHash: oneBit }),
    ]);

    expect(matchPhotoAlbums(left, reordered, { preset: 'SAME_IMAGE' })).toEqual({
      matched: true,
      strongestDistance: 1,
      usedPerceptualHash: true,
    });
    expect(matchPhotoAlbums(left, partial, { preset: 'SAME_IMAGE' }).matched).toBe(false);
  });

  it('uses canonical equality but blocks perceptual matching below the quality guard', () => {
    const lowQualityLeft = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashA, pdqHash: zero, pdqQuality: 49 }),
    ]);
    const lowQualityRight = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashB, pdqHash: oneBit, pdqQuality: 49 }),
    ]);
    const canonicalRight = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashA, pdqHash: far, pdqQuality: 0 }),
    ]);

    expect(
      matchPhotoAlbums(lowQualityLeft, lowQualityRight, { preset: 'MINOR_EDITS' }).matched,
    ).toBe(false);
    expect(matchPhotoAlbums(lowQualityLeft, canonicalRight, { preset: 'MINOR_EDITS' })).toEqual({
      matched: true,
      strongestDistance: 0,
      usedPerceptualHash: false,
    });
  });

  it('calculates the full 256-bit Hamming distance', () => {
    expect(hammingDistanceHex(zero, oneBit)).toBe(1);
    expect(hammingDistanceHex(zero, far)).toBe(256);
  });
});
