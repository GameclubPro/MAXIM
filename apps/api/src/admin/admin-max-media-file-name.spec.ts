import { canonicalizeAdminMaxMediaFileName } from './admin-max-media-file-name';

describe('canonicalizeAdminMaxMediaFileName', () => {
  it('keeps only a safe basename and replaces the claimed extension', () => {
    expect(canonicalizeAdminMaxMediaFileName('../photo\u0000.png', 'jpg', 'upload')).toBe(
      'photo_.jpg',
    );
  });

  it('keeps the canonical extension within the persisted 128-character limit', () => {
    const result = canonicalizeAdminMaxMediaFileName(
      `${'ф'.repeat(128)}.untrusted`,
      'tiff',
      'upload',
    );

    expect(result).toHaveLength(128);
    expect(result).toMatch(/\.tiff$/u);
  });

  it('uses a stable fallback when the requested basename is unusable', () => {
    expect(canonicalizeAdminMaxMediaFileName('../..', 'webm', 'publication-video')).toBe(
      'publication-video.webm',
    );
  });
});
