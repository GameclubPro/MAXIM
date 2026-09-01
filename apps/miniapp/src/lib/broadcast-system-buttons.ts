export type BroadcastSystemButtonPreview = {
  kind: 'comments' | 'suggest' | 'cta';
  text: string;
};

export function buildChatBroadcastSystemButtons(options: {
  commentsEnabled?: boolean;
  commentsChatBroadcastsEnabled?: boolean;
}): BroadcastSystemButtonPreview[] {
  if (!options.commentsEnabled || !options.commentsChatBroadcastsEnabled) {
    return [];
  }

  return [
    {
      text: '💬 Комментарии',
      kind: 'comments',
    },
  ];
}

export function buildChannelBroadcastSystemButtons(options: {
  commentsEnabled?: boolean;
  postSuggestionsEnabled?: boolean;
  postSuggestionsButtonText?: string | null;
  ctaButtonEnabled?: boolean;
  ctaButtonText?: string | null;
}): BroadcastSystemButtonPreview[] {
  const buttons: BroadcastSystemButtonPreview[] = [];

  if (options.commentsEnabled) {
    buttons.push({
      text: '💬 Комментарии',
      kind: 'comments',
    });
  }

  if (options.postSuggestionsEnabled) {
    buttons.push({
      text: options.postSuggestionsButtonText?.trim() || '📰 Предложить пост',
      kind: 'suggest',
    });
  }

  if (options.ctaButtonEnabled && options.ctaButtonText?.trim()) {
    buttons.push({
      text: options.ctaButtonText.trim(),
      kind: 'cta',
    });
  }

  return buttons;
}
