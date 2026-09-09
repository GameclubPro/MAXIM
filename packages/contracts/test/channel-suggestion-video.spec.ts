import { describe, expect, it } from 'vitest';
import {
  createChannelDialogMessageRequestSchema,
  MAX_CHANNEL_SUGGESTION_VIDEO_BASE64_LENGTH,
} from '../src/channel-dialog';

const video = { base64: 'dmlkZW8=', mimeType: 'video/mp4', fileName: 'clip.mp4' };
const request = { token: 'signed-dialog-token-0001', video };

describe('suggestion video input', () => {
  it('accepts an optional standalone video without changing existing image requests', () => {
    expect(createChannelDialogMessageRequestSchema.parse(request).video).toEqual(video);
    expect(
      createChannelDialogMessageRequestSchema.parse({ token: request.token, text: 'Text' }).video,
    ).toBeUndefined();
  });
  it.each([
    { images: [{ base64: 'aW1hZ2U=', mimeType: 'image/jpeg' }] },
    { imageBase64: 'aW1hZ2U=', imageMimeType: 'image/jpeg' },
    { attachments: [{ type: 'image', base64: 'aW1hZ2U=', mimeType: 'image/jpeg' }] },
  ])('rejects mixed image and video input', (other) => {
    expect(
      createChannelDialogMessageRequestSchema.safeParse({ ...request, ...other }).success,
    ).toBe(false);
  });
  it('rejects unsupported and oversized video input', () => {
    expect(
      createChannelDialogMessageRequestSchema.safeParse({
        ...request,
        video: { ...video, mimeType: 'image/svg+xml' },
      }).success,
    ).toBe(false);
    expect(
      createChannelDialogMessageRequestSchema.safeParse({
        ...request,
        video: { ...video, base64: 'A'.repeat(MAX_CHANNEL_SUGGESTION_VIDEO_BASE64_LENGTH + 4) },
      }).success,
    ).toBe(false);
  });
});
