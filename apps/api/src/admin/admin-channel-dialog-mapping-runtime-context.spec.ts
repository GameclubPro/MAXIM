import { createAdminChannelDialogMappingRuntimeContext } from './admin-channel-dialog-mapping-runtime-context';

describe('AdminChannelDialogMappingRuntimeContext', () => {
  it('delegates channel dialog mapping helpers through explicit typed ports', () => {
    const target = {
      buildChannelDialogCommentAttachments: jest.fn().mockReturnValue([{ kind: 'image' }]),
      normalizeBroadcastTextFormat: jest.fn().mockReturnValue('markdown'),
      normalizeChannelSuggestionImages: jest.fn().mockReturnValue([{ base64: 'image' }]),
      readChannelDialogAttachmentAssets: jest.fn().mockReturnValue([{ kind: 'image' }]),
      readChannelDialogSuggestionReviewStatus: jest.fn().mockReturnValue('published'),
      readChannelSuggestionImageAssets: jest.fn().mockReturnValue([{ base64: 'suggestion' }]),
      readChannelSuggestionMediaType: jest.fn().mockReturnValue('video'),
      readDialogReactionGroups: jest.fn().mockReturnValue([{ emoji: 'ok', count: 1 }]),
      readDialogReplyPreview: jest.fn().mockReturnValue({ messageId: 'reply-1', text: 'Reply' }),
      readLowerString: jest.fn().mockReturnValue('comments'),
      readObjectPayload: jest.fn().mockReturnValue({ type: 'comments' }),
      readObjectPayloadOrNull: jest.fn().mockReturnValue({ payload: true }),
      readTrimmedString: jest.fn().mockReturnValue('value'),
      toSafeInteger: jest.fn().mockReturnValue(7),
    };
    const context = createAdminChannelDialogMappingRuntimeContext(target);

    expect(context.buildChannelDialogCommentAttachments([])).toEqual([{ kind: 'image' }]);
    expect(context.normalizeBroadcastTextFormat('markdown')).toBe('markdown');
    expect(context.normalizeChannelSuggestionImages({ mediaType: 'image' })).toEqual([
      { base64: 'image' },
    ]);
    expect(context.readChannelDialogAttachmentAssets([])).toEqual([{ kind: 'image' }]);
    expect(context.readChannelDialogSuggestionReviewStatus('published')).toBe('published');
    expect(context.readChannelSuggestionImageAssets([])).toEqual([{ base64: 'suggestion' }]);
    expect(context.readChannelSuggestionMediaType('video')).toBe('video');
    expect(context.readDialogReactionGroups([], 'user-1')).toEqual([{ emoji: 'ok', count: 1 }]);
    expect(context.readDialogReplyPreview({ messageId: 'reply-1', text: 'Reply' })).toEqual({
      messageId: 'reply-1',
      text: 'Reply',
    });
    expect(context.readLowerString(' COMMENTS ')).toBe('comments');
    expect(context.readObjectPayload({ type: 'comments' })).toEqual({ type: 'comments' });
    expect(context.readObjectPayloadOrNull({ payload: true })).toEqual({ payload: true });
    expect(context.readTrimmedString(' value ')).toBe('value');
    expect(context.toSafeInteger('7')).toBe(7);

    expect(target.normalizeChannelSuggestionImages).toHaveBeenCalledWith({ mediaType: 'image' });
    expect(target.readDialogReactionGroups).toHaveBeenCalledWith([], 'user-1');
  });

  it('preserves the legacy target context for helper delegates', () => {
    const target = {
      prefix: 'legacy',
      readTrimmedString(value: unknown): string | null {
        return typeof value === 'string' ? `${this.prefix}:${value.trim()}` : null;
      },
      readLowerString(value: unknown): string | null {
        return this.readTrimmedString(value)?.toLowerCase() ?? null;
      },
      readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null {
        const normalized = this.readLowerString(value);
        return normalized === 'legacy:image' ? 'image' : null;
      },
      toSafeInteger(value: unknown): number {
        return typeof value === 'number' ? value + this.prefix.length : 0;
      },
    };
    const context = createAdminChannelDialogMappingRuntimeContext(target);

    expect(context.readLowerString(' IMAGE ')).toBe('legacy:image');
    expect(context.readChannelSuggestionMediaType(' IMAGE ')).toBe('image');
    expect(context.toSafeInteger(1)).toBe(7);
  });
});
