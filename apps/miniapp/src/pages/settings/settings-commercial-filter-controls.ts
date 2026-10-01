import type { AdminContactButtonGroup, ChatSettingsButtonGroup } from './settings-page-helpers';

export const COMMERCIAL_SENSITIVITY_MIN = 0;
export const COMMERCIAL_SENSITIVITY_MAX = 100;
export const TEXT_FILTERS_BOT_BUTTON_GROUP = {
  buttonsKey: 'textFiltersBotButtons',
  enabledKey: 'textFiltersBotButtonEnabled',
  urlKey: 'textFiltersBotButtonUrl',
  textKey: 'textFiltersBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const TEXT_FILTERS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'textFiltersAdminContactButtonEnabled',
  urlKey: 'textFiltersAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
