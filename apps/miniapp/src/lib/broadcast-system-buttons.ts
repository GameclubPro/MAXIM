import type { BroadcastLinkButton } from '@maxim/contracts';

export function buildChatBroadcastSystemButtons(options: {
  commentsEnabled?: boolean;
  commentsChatBroadcastsEnabled?: boolean;
}): BroadcastLinkButton[] {
  if (!options.commentsEnabled || !options.commentsChatBroadcastsEnabled) {
    return [];
  }

  return [
    {
      text: '💬 Комментарии',
      url: '#comments',
    },
  ];
}

export function buildChannelBroadcastSystemButtons(options: {
  commentsEnabled?: boolean;
  postSuggestionsEnabled?: boolean;
  postSuggestionsButtonText?: string | null;
}): BroadcastLinkButton[] {
  const buttons: BroadcastLinkButton[] = [];

  if (options.commentsEnabled) {
    buttons.push({
      text: '💬 Комментарии',
      url: '#comments',
    });
  }

  if (options.postSuggestionsEnabled) {
    buttons.push({
      text: options.postSuggestionsButtonText?.trim() || '📰 Предложить пост',
      url: '#suggest',
    });
  }

  return buttons;
}
