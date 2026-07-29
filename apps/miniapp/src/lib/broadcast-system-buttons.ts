import type { ChannelAutoPostButtonsMode } from '@maxim/contracts';

export type BroadcastSystemButtonPreview = {
  kind: 'comments' | 'suggest';
  text: string;
};

export function enableChannelSuggestionAutoPostButton(
  mode: ChannelAutoPostButtonsMode,
): ChannelAutoPostButtonsMode {
  if (mode === 'OFF') {
    return 'SUGGEST';
  }
  if (mode === 'COMMENTS') {
    return 'BOTH';
  }
  return mode;
}

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
  autoPostButtonsMode?: ChannelAutoPostButtonsMode | null;
}): BroadcastSystemButtonPreview[] {
  const buttons: BroadcastSystemButtonPreview[] = [];
  const mode = options.autoPostButtonsMode ?? 'BOTH';
  const includeComments = mode === 'COMMENTS' || mode === 'BOTH';
  const includeSuggest = mode === 'SUGGEST' || mode === 'BOTH';

  if (options.commentsEnabled && includeComments) {
    buttons.push({
      text: '💬 Комментарии',
      kind: 'comments',
    });
  }

  if (options.postSuggestionsEnabled && includeSuggest) {
    buttons.push({
      text: options.postSuggestionsButtonText?.trim() || '📰 Предложить пост',
      kind: 'suggest',
    });
  }

  return buttons;
}
