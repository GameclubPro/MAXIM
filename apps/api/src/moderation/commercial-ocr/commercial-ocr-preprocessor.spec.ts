import sharp from 'sharp';
import {
  COMMERCIAL_OCR_PREPROCESS_PROFILES,
  CommercialOcrImageRejectedError,
  CommercialOcrPreprocessor,
} from './commercial-ocr-preprocessor';

function service(values: Record<string, unknown> = {}) {
  return new CommercialOcrPreprocessor({ get: (key: string) => values[key] } as never);
}

describe('CommercialOcrPreprocessor', () => {
  it('autorotates and bounds the OCR raster', async () => {
    const input = await sharp({
      create: { width: 3_000, height: 1_500, channels: 3, background: 'white' },
    })
      .jpeg()
      .toBuffer();
    const result = await service({
      COMMERCIAL_OCR_MAX_SIDE: 1_000,
      COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: 500_000,
    }).prepare(input, 'primary');
    expect(result.width).toBeLessThanOrEqual(1_000);
    expect(result.width * result.height).toBeLessThanOrEqual(500_000);
    await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: 'png' });
  });

  it.each([6, 8] as const)(
    'uses oriented dimensions when bounding EXIF orientation %s',
    async (orientation) => {
      const input = await sharp({
        create: { width: 1_200, height: 600, channels: 3, background: 'white' },
      })
        .jpeg()
        .withMetadata({ orientation })
        .toBuffer();

      const result = await service({
        COMMERCIAL_OCR_MAX_SIDE: 800,
        COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: 1_000_000,
      }).prepare(input, 'primary');

      expect(result).toMatchObject({ width: 400, height: 800 });
      expect(result.width * result.height).toBeLessThanOrEqual(1_000_000);
    },
  );

  it('rejects malformed inputs fail-open', async () => {
    await expect(service().prepare(Buffer.from('not an image'), 'primary')).rejects.toBeInstanceOf(
      CommercialOcrImageRejectedError,
    );
  });

  it('uses a distinct binary profile for confirmation', async () => {
    const png = await sharp(Buffer.from([0, 127, 255, 0, 127, 255, 0, 127, 255]), {
      raw: { width: 3, height: 1, channels: 3 },
    })
      .png()
      .toBuffer();

    const primary = await service().prepare(png, 'primary');
    const confirmation = await service().prepare(png, 'confirmation');
    const primaryPixels = await sharp(primary.bytes).raw().toBuffer();
    const confirmationPixels = await sharp(confirmation.bytes).raw().toBuffer();

    expect([...primaryPixels].some((value) => value !== 0 && value !== 255)).toBe(true);
    expect([...confirmationPixels].every((value) => value === 0 || value === 255)).toBe(true);
    expect(COMMERCIAL_OCR_PREPROCESS_PROFILES).toEqual({
      primary: 'gray-bounded-v3',
      confirmation: 'normalized-threshold160-v3',
    });
  });
});
