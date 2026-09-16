import { describe, expect, it } from 'vitest';
import {
  createPublicationVideoUploadSchema,
  MAX_PUBLICATION_VIDEO_BASE64_LENGTH,
  MAX_PUBLICATION_VIDEO_UPLOAD_BYTES,
  publicationVideoUploadStatusSchema,
} from '@maxim/contracts/publication';

describe('publication direct video upload', () => {
  const request = {
    requestId: 'upload_request_123456',
    mimeType: 'video/mp4',
    fileName: 'clip.mp4',
    sizeBytes: 36_000_000,
  };
  it('accepts 36 and 100 MB metadata without widening the inline base64 limit', () => {
    expect(createPublicationVideoUploadSchema.parse(request).sizeBytes).toBe(36_000_000);
    expect(
      createPublicationVideoUploadSchema.parse({
        ...request,
        sizeBytes: MAX_PUBLICATION_VIDEO_UPLOAD_BYTES,
      }).sizeBytes,
    ).toBe(100_000_000);
    expect(MAX_PUBLICATION_VIDEO_BASE64_LENGTH).toBe(32_000_000);
  });
  it('rejects oversized, empty, unsupported, and inline data', () => {
    for (const invalid of [
      { sizeBytes: 100_000_001 },
      { sizeBytes: 0 },
      { sizeBytes: -1 },
      { mimeType: 'text/html' },
      { base64: 'AAAA' },
    ]) {
      expect(createPublicationVideoUploadSchema.safeParse({ ...request, ...invalid }).success).toBe(
        false,
      );
    }
  });
  it('returns only public attachment metadata after readiness', () => {
    const response = publicationVideoUploadStatusSchema.parse({
      status: 'READY',
      uploadId: request.requestId,
      asset: {
        id: 'asset',
        type: 'video',
        fileName: request.fileName,
        mimeType: request.mimeType,
        sizeBytes: request.sizeBytes,
        token: 'secret',
      },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});
