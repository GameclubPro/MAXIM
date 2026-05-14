import type { BroadcastWorkspaceView } from '../components/broadcast-studio-workspace';

export type SettingsWorkspaceKey =
  | 'moderation'
  | 'rules'
  | 'requiredSubscription'
  | 'broadcast'
  | 'giveaway'
  | 'members';

export type SettingsWorkspaceState = {
  activeWorkspace: SettingsWorkspaceKey | null;
  broadcastView: BroadcastWorkspaceView;
  hasDirtyDraft: boolean;
};
