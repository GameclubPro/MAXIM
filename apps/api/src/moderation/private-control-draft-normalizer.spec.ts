import { DEFAULT_BROADCAST_BUTTON_TEXT, MAX_CHANNEL_DIALOG_SUGGEST_IMAGES } from '@maxim/contracts';
import { DEFAULT_BROADCAST_DRAFT } from './private-control.constants';
import {
  clonePrivateBroadcastDraft,
  normalizePrivateBroadcastDraft,
  normalizePrivateBroadcastTargetChatIds,
  normalizePrivateSuggestionDraft,
  resolvePrivateBroadcastDraftTargetState,
} from './private-control-draft-normalizer';

describe('private control draft normalizer', () => {
  it('returns an isolated default broadcast draft for invalid raw payloads', () => {
    const draft = normalizePrivateBroadcastDraft(null);

    expect(draft).toEqual(DEFAULT_BROADCAST_DRAFT);
    expect(draft).not.toBe(DEFAULT_BROADCAST_DRAFT);
    expect(draft.buttons).toBe(DEFAULT_BROADCAST_DRAFT.buttons);
  });

  it('clones mutable broadcast draft collections', () => {
    const draft = {
      ...DEFAULT_BROADCAST_DRAFT,
      buttons: [{ text: 'Open', url: 'https://example.com' }],
      targetChatIds: ['chat-1'],
      scheduledSlots: ['2026-06-24T12:00:00.000Z'],
      mediaPayload: { token: 'media-token' },
    };

    const clone = clonePrivateBroadcastDraft(draft);

    expect(clone).toEqual(draft);
    expect(clone).not.toBe(draft);
    expect(clone.buttons).not.toBe(draft.buttons);
    expect(clone.buttons[0]).not.toBe(draft.buttons[0]);
    expect(clone.targetChatIds).not.toBe(draft.targetChatIds);
    expect(clone.scheduledSlots).not.toBe(draft.scheduledSlots);
    expect(clone.mediaPayload).not.toBe(draft.mediaPayload);
  });

  it('normalizes broadcast buttons, target state, calendar slots, and cycle fields', () => {
    const draft = normalizePrivateBroadcastDraft({
      text: 'Hello',
      textFormat: 'markdown',
      targetMode: 'selected',
      targetChatIds: [' chat-1 ', '', 'chat-1', 'chat-2'],
      buttons: [
        { text: '  ', url: ' https://one.example ' },
        { text: 'Open', url: ' https://two.example ' },
        { text: 'Skip', url: '   ' },
      ],
      scheduleMode: 'calendar',
      scheduleTimezone: ' Europe/Moscow ',
      scheduledSlots: [' 2026-06-24T10:00:00.000Z ', '', '2026-06-24T09:00:00.000Z'],
      sendAt: '2026-06-24T08:00:00.000Z',
      cycleEveryDays: 2,
      cycleCount: '3',
    });

    expect(draft).toEqual(
      expect.objectContaining({
        text: 'Hello',
        textFormat: 'markdown',
        targetMode: 'selected',
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [
          { text: DEFAULT_BROADCAST_BUTTON_TEXT, url: 'https://one.example' },
          { text: 'Open', url: 'https://two.example' },
        ],
        buttonEnabled: true,
        buttonUrl: 'https://one.example',
        buttonText: DEFAULT_BROADCAST_BUTTON_TEXT,
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-06-24T09:00:00.000Z', '2026-06-24T10:00:00.000Z'],
        sendAt: '2026-06-24T08:00:00.000Z',
        cycleEveryHours: 48,
        cycleCount: 3,
      }),
    );
  });

  it('migrates legacy broadcast button fields', () => {
    expect(
      normalizePrivateBroadcastDraft({
        buttonEnabled: true,
        buttonUrl: ' https://legacy.example ',
        buttonText: '  ',
      }),
    ).toEqual(
      expect.objectContaining({
        buttons: [{ text: DEFAULT_BROADCAST_BUTTON_TEXT, url: 'https://legacy.example' }],
        buttonEnabled: true,
        buttonUrl: 'https://legacy.example',
        buttonText: DEFAULT_BROADCAST_BUTTON_TEXT,
      }),
    );
  });

  it('keeps video media mutually exclusive with legacy image fields', () => {
    const draft = normalizePrivateBroadcastDraft({
      imageEnabled: true,
      imageBase64: 'base64',
      imageMimeType: 'image/png',
      imageFileName: 'image.png',
      mediaType: 'video',
      mediaPayload: { token: 'video-token' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'video.mp4',
    });

    expect(draft).toEqual(
      expect.objectContaining({
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        mediaType: 'video',
        mediaPayload: { token: 'video-token' },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'video.mp4',
      }),
    );

    expect(
      normalizePrivateBroadcastDraft({
        mediaType: 'video',
        mediaPayload: null,
        imageEnabled: true,
      }),
    ).toEqual(expect.objectContaining({ mediaType: null, mediaPayload: null, imageEnabled: true }));
  });

  it('normalizes broadcast target ids and target state', () => {
    expect(normalizePrivateBroadcastTargetChatIds([' chat-1 ', 'chat-1', ''], 'fallback')).toEqual([
      'chat-1',
    ]);
    expect(normalizePrivateBroadcastTargetChatIds([], ' fallback ')).toEqual(['fallback']);

    expect(
      resolvePrivateBroadcastDraftTargetState({
        targetMode: 'current',
        targetChatIds: [],
        fallbackChatId: ' chat-1 ',
      }),
    ).toEqual({
      targetMode: 'current',
      targetChatIds: ['chat-1'],
      applyToAllChats: false,
    });
    expect(
      resolvePrivateBroadcastDraftTargetState({
        targetMode: 'selected',
        targetChatIds: [],
      }),
    ).toEqual({
      targetMode: 'selected',
      targetChatIds: [],
      applyToAllChats: false,
    });
    expect(
      resolvePrivateBroadcastDraftTargetState({
        targetMode: 'current',
        targetChatIds: ['chat-1', 'chat-2'],
        applyToAllChats: true,
      }),
    ).toEqual({
      targetMode: 'all',
      targetChatIds: ['chat-1', 'chat-2'],
      applyToAllChats: true,
    });
  });

  it('normalizes suggestion legacy media, media lists, and text markup', () => {
    const validImages = Array.from(
      { length: MAX_CHANNEL_DIALOG_SUGGEST_IMAGES + 2 },
      (_, index) => ({
        kind: 'image',
        mimeType: ` image/${index} `,
        fileName: ` image-${index}.png `,
        payload: { token: `image-${index}` },
      }),
    );
    const draft = normalizePrivateSuggestionDraft({
      chatId: ' channel-1 ',
      token: ' token-1 ',
      text: 'Suggestion',
      textFormat: 'markdown',
      images: [
        { kind: 'video', mimeType: 'video/mp4', fileName: 'video.mp4', payload: { token: 'bad' } },
        { kind: 'image', mimeType: 'image/empty', fileName: 'empty.png', payload: {} },
        ...validImages,
      ],
      video: {
        kind: 'video',
        mimeType: ' video/mp4 ',
        fileName: ' video.mp4 ',
        payload: { token: 'video-token' },
      },
      mediaBotId: ' source-private-bot ',
      media: {
        kind: 'video',
        mimeType: 'video/legacy',
        fileName: 'legacy.mp4',
        payload: { token: 'legacy-video' },
      },
      textMarkup: [
        { type: 'strong', from: 0, length: 5 },
        { type: 'link', from: '6', length: '4', url: ' https://example.com ' },
        { type: 'bad', from: 0, length: 1 },
      ],
      sourceMessageId: ' source ',
      previewMessageId: ' preview ',
    });

    expect(draft).toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        token: 'token-1',
        text: 'Suggestion',
        textFormat: 'markdown',
        video: {
          kind: 'video',
          mimeType: 'video/mp4',
          fileName: 'video.mp4',
          payload: { token: 'video-token' },
        },
        mediaBotId: 'source-private-bot',
        sourceMessageId: 'source',
        previewMessageId: 'preview',
      }),
    );
    expect(draft?.images).toHaveLength(MAX_CHANNEL_DIALOG_SUGGEST_IMAGES);
    expect(draft?.images[0]).toEqual({
      kind: 'image',
      mimeType: 'image/0',
      fileName: 'image-0.png',
      payload: { token: 'image-0' },
    });
    expect(draft?.textMarkup).toEqual([
      { type: 'strong', from: 0, length: 5, url: null, userLink: null },
      { type: 'link', from: 6, length: 4, url: 'https://example.com', userLink: null },
    ]);
  });

  it('falls back to legacy image media and rejects incomplete suggestions', () => {
    expect(normalizePrivateSuggestionDraft({ chatId: 'channel-1' })).toBeNull();
    expect(normalizePrivateSuggestionDraft({ token: 'token-1' })).toBeNull();

    expect(
      normalizePrivateSuggestionDraft({
        chatId: 'channel-1',
        token: 'token-1',
        media: {
          kind: 'image',
          mimeType: ' image/png ',
          fileName: ' image.png ',
          payload: { token: 'legacy-image' },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        images: [
          {
            kind: 'image',
            mimeType: 'image/png',
            fileName: 'image.png',
            payload: { token: 'legacy-image' },
          },
        ],
        video: null,
      }),
    );
  });
});
