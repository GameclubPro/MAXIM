import sharp from 'sharp';
import {
  MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES,
  normalizeUnsupportedMaxImageUpload,
} from './max-image-upload-normalization';
import { validateMaxMediaUploadPayload } from './max-media-upload-validation';

describe('MAX image upload normalization', () => {
  it.each([
    { alpha: false, input: 'webp' as const, output: 'jpeg' },
    { alpha: true, input: 'avif' as const, output: 'png' },
  ])('normalizes $input into a validated $output upload', async ({ alpha, input, output }) => {
    const source = sharp({
      create: {
        width: 9,
        height: 7,
        channels: alpha ? 4 : 3,
        background: alpha ? { r: 30, g: 90, b: 180, alpha: 0.5 } : { r: 30, g: 90, b: 180 },
      },
    });
    const bytes =
      input === 'webp' ? await source.webp().toBuffer() : await source.avif().toBuffer();

    const normalized = await normalizeUnsupportedMaxImageUpload(bytes, 1_000_000);

    await expect(validateMaxMediaUploadPayload('image', normalized.bytes)).resolves.toMatchObject({
      format: output,
      mimeType: normalized.mimeType,
      extension: normalized.extension,
    });
  });

  it('enforces the caller output byte limit', async () => {
    const webp = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .webp()
      .toBuffer();

    await expect(normalizeUnsupportedMaxImageUpload(webp, 1)).rejects.toMatchObject({
      code: MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.OUTPUT_TOO_LARGE,
    });
  });

  it('returns a typed transcode failure for invalid bytes', async () => {
    await expect(
      normalizeUnsupportedMaxImageUpload(Buffer.from('not-an-image'), 1_000_000),
    ).rejects.toMatchObject({
      code: MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.TRANSCODE_FAILED,
    });
  });
});
