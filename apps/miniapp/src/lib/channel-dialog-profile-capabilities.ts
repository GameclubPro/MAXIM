import type { MiniappProfile } from '@maxim/contracts/publisher';

export type ChannelDialogProfileCapabilities = {
  canManageCommentNotifications: boolean;
  canUploadCommentAttachments: boolean;
};

export function resolveChannelDialogProfileCapabilities(
  profile: MiniappProfile,
): ChannelDialogProfileCapabilities {
  const majorRoutedControls = profile === 'moderation';
  return {
    canManageCommentNotifications: majorRoutedControls,
    canUploadCommentAttachments: majorRoutedControls,
  };
}
