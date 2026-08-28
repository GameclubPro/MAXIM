import { extractMaxVideoDownloadUrl } from './max-video-download-url.util';

describe('extractMaxVideoDownloadUrl', () => {
  it('reads quality-keyed VideoUrls and prefers MP4 over a manifest', () => {
    expect(
      extractMaxVideoDownloadUrl({
        urls: {
          hls: 'https://cdn.max.ru/v.m3u8',
          mp4_720: 'https://cdn.max.ru/v.mp4',
        },
      }),
    ).toBe('https://cdn.max.ru/v.mp4');
  });

  it('ignores non-HTTPS and over-deep candidates', () => {
    expect(extractMaxVideoDownloadUrl({ urls: { mp4: 'http://cdn.max.ru/v.mp4' } })).toBeNull();
    expect(
      extractMaxVideoDownloadUrl({
        a: { b: { c: { d: { e: { mp4: 'https://cdn.max.ru/v.mp4' } } } } },
      }),
    ).toBeNull();
  });

  it('does not mistake an HLS manifest or thumbnail for downloadable video bytes', () => {
    expect(
      extractMaxVideoDownloadUrl({
        urls: { hls: 'https://cdn.max.ru/v.m3u8' },
        thumbnail: { url: 'https://cdn.max.ru/v.jpg' },
      }),
    ).toBeNull();
  });
});
