import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeImageMimeType,
  resolveInputImageMimeType,
} from '../src/lib/broadcast-image-format';

test('repairs generic native MIME metadata using the extension', () => {
  for (const type of ['', 'application/octet-stream', 'application/binary', 'image/*']) {
    assert.equal(
      resolveInputImageMimeType({ type, name: 'PHOTO.JPG' }, new Uint8Array()),
      'image/jpeg',
    );
    assert.equal(
      resolveInputImageMimeType({ type, name: 'photo.avif' }, new Uint8Array()),
      'image/avif',
    );
  }
  assert.equal(normalizeImageMimeType(' IMAGE/PJPEG; charset=binary '), 'image/jpeg');
  assert.equal(normalizeImageMimeType('image/x-png'), 'image/png');
  assert.equal(normalizeImageMimeType('image/x-ms-bmp'), 'image/bmp');
});

test('recognized bytes override incorrect MIME and filename, including native nameless photos', () => {
  const cases: Array<[number[] | string, string]> = [
    [[0xff, 0xd8, 0xff], 'image/jpeg'],
    [[137, 80, 78, 71, 13, 10, 26, 10], 'image/png'],
    ['GIF89a', 'image/gif'],
    ['GIF87a', 'image/gif'],
    ['RIFF0000WEBP', 'image/webp'],
    ['BM', 'image/bmp'],
    [[73, 73, 42, 0], 'image/tiff'],
    [[77, 77, 0, 42], 'image/tiff'],
    ['0000ftypheic', 'image/heic'],
    ['0000ftypavif', 'image/avif'],
  ];
  for (const [value, expected] of cases) {
    const header =
      typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    assert.equal(
      resolveInputImageMimeType(
        { name: 'native-file.bin', type: 'application/octet-stream' },
        header,
      ),
      expected,
    );
    assert.equal(
      resolveInputImageMimeType({ name: 'wrong.jpg', type: 'image/jpeg' }, header),
      expected,
    );
  }
});

test('does not mistake generic HEIF, a partial signature or an arbitrary RIFF container for supported originals', () => {
  for (const text of ['0000ftypmif1', 'RIFF0000WAVE', 'GIF', 'not an image']) {
    assert.equal(
      resolveInputImageMimeType({ name: 'file', type: '' }, new TextEncoder().encode(text)),
      '',
    );
  }
  assert.equal(
    resolveInputImageMimeType(
      { name: 'photo.heif', type: 'image/heif' },
      new TextEncoder().encode('0000ftypmif1'),
    ),
    'image/heif',
  );
});
