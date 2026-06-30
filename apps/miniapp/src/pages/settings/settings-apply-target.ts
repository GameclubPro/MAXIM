import type { ApplySettingsTarget } from '@maxim/contracts/settings';

export function createDefaultApplySettingsTarget(): ApplySettingsTarget {
  return {
    mode: 'current',
    favoriteTypes: [],
    chatIds: [],
  };
}
