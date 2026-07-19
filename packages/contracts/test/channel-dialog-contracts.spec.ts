import { describe, expect, it } from 'vitest';

import {
  channelDialogMessageSchema as rootChannelDialogMessageSchema,
  createChannelDialogMessageRequestSchema as rootCreateChannelDialogMessageRequestSchema,
} from '@maxim/contracts';
import {
  channelDialogMessageSchema,
  createChannelDialogMessageRequestSchema,
} from '@maxim/contracts/channel-dialog';

describe('channel dialog contract exports', () => {
  it('keeps root and subpath exports aligned', () => {
    expect(rootCreateChannelDialogMessageRequestSchema).toBe(
      createChannelDialogMessageRequestSchema,
    );
    expect(rootChannelDialogMessageSchema).toBe(channelDialogMessageSchema);
  });

  it('normalizes legacy image payloads into dialog images and attachments', () => {
    const result = createChannelDialogMessageRequestSchema.parse({
      token: '1234567890abcdef',
      text: 'Предложка',
      imageBase64: ' image-data ',
      imageMimeType: ' image/png ',
      imageFileName: ' post.png ',
    });

    expect(result.images).toEqual([
      {
        base64: 'image-data',
        mimeType: 'image/png',
        fileName: 'post.png',
      },
    ]);
    expect(result.attachments).toEqual([
      {
        type: 'image',
        base64: 'image-data',
        mimeType: 'image/png',
        fileName: 'post.png',
        width: undefined,
        height: undefined,
      },
    ]);
  });
});
