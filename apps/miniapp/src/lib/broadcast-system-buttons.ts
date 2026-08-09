export type BroadcastSystemButtonPreview = {
  kind: 'comments' | 'suggest';
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

  return buttons;
}
