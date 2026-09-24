const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

export function normalizeImageMimeType(value: string): string {
  const type = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (['image/jpg', 'image/pjpeg'].includes(type)) return 'image/jpeg';
  if (type === 'image/x-png') return 'image/png';
  if (['image/x-ms-bmp', 'image/x-bmp'].includes(type)) return 'image/bmp';
  return type.startsWith('image/') && type !== 'image/*' ? type : '';
}

// FLAG: Header hints repair native-picker metadata; server byte validation remains authoritative.
export function resolveInputImageMimeType(
  file: Pick<File, 'name' | 'type'>,
  header: Uint8Array,
): string {
  const matches = (bytes: readonly number[], offset = 0) =>
    bytes.every((value, index) => header[offset + index] === value);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...header.subarray(offset, offset + length));
  if (matches([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if (matches([73, 73, 42, 0]) || matches([77, 77, 0, 42])) return 'image/tiff';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
  }
  const extension =
    file.name
      .trim()
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/u)?.[1] ?? '';
  return normalizeImageMimeType(file.type) || MIME_BY_EXTENSION[extension] || '';
}
