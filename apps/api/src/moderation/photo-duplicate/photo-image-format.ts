export const SUPPORTED_PHOTO_IMAGE_FORMATS = Object.freeze([
  'jpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'heif',
  'tiff',
] as const);

export type SupportedPhotoImageFormat = (typeof SUPPORTED_PHOTO_IMAGE_FORMATS)[number];

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const TIFF_LITTLE_ENDIAN_SIGNATURE = Buffer.from('49492a00', 'hex');
const TIFF_BIG_ENDIAN_SIGNATURE = Buffer.from('4d4d002a', 'hex');
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

/** Keeps downloaded runtime images and offline certification on the same raster allowlist. */
export function detectSupportedPhotoImageFormat(bytes: Buffer): SupportedPhotoImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    return 'gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (
    bytes.length >= 4 &&
    (bytes.subarray(0, 4).equals(TIFF_LITTLE_ENDIAN_SIGNATURE) ||
      bytes.subarray(0, 4).equals(TIFF_BIG_ENDIAN_SIGNATURE))
  ) {
    return 'tiff';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') {
      return 'avif';
    }
    if (HEIF_BRANDS.has(brand)) {
      return 'heif';
    }
  }
  return null;
}
