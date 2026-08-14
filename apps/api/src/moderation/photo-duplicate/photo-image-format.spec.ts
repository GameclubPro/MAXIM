import {
  detectSupportedPhotoImageFormat,
  SUPPORTED_PHOTO_IMAGE_FORMATS,
} from './photo-image-format';

describe('photo image format policy', () => {
  it.each([
    ['jpeg', Buffer.from('ffd8ff00', 'hex')],
    ['png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['gif', Buffer.from('GIF89a', 'ascii')],
    ['webp', Buffer.from('524946460000000057454250', 'hex')],
    ['tiff', Buffer.from('49492a00', 'hex')],
    ['avif', Buffer.from('000000006674797061766966', 'hex')],
    ['heif', Buffer.from('000000006674797068656963', 'hex')],
  ] as const)('recognizes the supported %s signature', (format, bytes) => {
    expect(detectSupportedPhotoImageFormat(bytes)).toBe(format);
  });

  it('keeps the exported allowlist aligned with detection and rejects non-raster input', () => {
    expect(SUPPORTED_PHOTO_IMAGE_FORMATS).toEqual([
      'jpeg',
      'png',
      'webp',
      'gif',
      'avif',
      'heif',
      'tiff',
    ]);
    expect(detectSupportedPhotoImageFormat(Buffer.from('<svg></svg>', 'utf8'))).toBeNull();
  });
});
