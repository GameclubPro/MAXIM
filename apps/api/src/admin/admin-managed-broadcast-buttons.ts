import {
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  type BroadcastLinkButton,
} from '@maxim/contracts';
import type { MaxMessageButton } from '../max/max-client.service';
import { normalizeLegacyProfileButtonUrl } from './admin-profile-links';

export type ManagedBroadcastLegacyButtonState = {
  buttonEnabled?: boolean;
  buttonUrl?: string | null;
  buttonText?: string | null;
};

export type ManagedBroadcastButtonState = {
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
};

export type ManagedBroadcastLinkButtonRowsOptions = {
  buttonsPerRow?: number;
};

export function normalizeManagedBroadcastButtons(
  rawButtons: unknown,
  legacy?: ManagedBroadcastLegacyButtonState,
): BroadcastLinkButton[] {
  const normalizedButtons: BroadcastLinkButton[] = [];

  if (Array.isArray(rawButtons)) {
    for (const item of rawButtons) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const row = item as { text?: unknown; url?: unknown };
      const url = normalizeLegacyProfileButtonUrl(typeof row.url === 'string' ? row.url : '');

      if (!url) {
        continue;
      }

      normalizedButtons.push({
        text:
          typeof row.text === 'string' && row.text.trim().length > 0
            ? row.text.trim()
            : DEFAULT_BROADCAST_BUTTON_TEXT,
        url,
      });

      if (normalizedButtons.length >= MAX_BROADCAST_LINK_BUTTONS) {
        break;
      }
    }
  }

  if (normalizedButtons.length > 0) {
    return normalizedButtons;
  }

  if (legacy?.buttonEnabled !== true) {
    return [];
  }

  const legacyUrl = normalizeLegacyProfileButtonUrl(legacy.buttonUrl ?? '');
  if (!legacyUrl) {
    return [];
  }

  return [
    {
      text: legacy.buttonText?.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
      url: legacyUrl,
    },
  ];
}

export function buildManagedBroadcastButtonState(
  rawButtons: unknown,
  legacy?: ManagedBroadcastLegacyButtonState,
): ManagedBroadcastButtonState {
  const buttons = normalizeManagedBroadcastButtons(rawButtons, legacy);
  const primaryButton = buttons[0];

  return {
    buttons,
    buttonEnabled: buttons.length > 0,
    buttonUrl: primaryButton?.url ?? '',
    buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
  };
}

export function buildManagedBroadcastLinkButtonRows(
  buttons: readonly BroadcastLinkButton[],
  options: ManagedBroadcastLinkButtonRowsOptions = {},
): MaxMessageButton[][] {
  const rows: MaxMessageButton[][] = [];
  const buttonsPerRow = normalizeManagedBroadcastLinkButtonsPerRow(options.buttonsPerRow);

  for (let index = 0; index < buttons.length; index += buttonsPerRow) {
    rows.push(
      buttons.slice(index, index + buttonsPerRow).map((button) => ({
        type: 'link',
        text: button.text,
        url: button.url,
      })),
    );
  }

  return rows;
}

function normalizeManagedBroadcastLinkButtonsPerRow(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_BROADCAST_LINK_BUTTONS_PER_ROW;
  }

  return Math.max(1, Math.min(MAX_BROADCAST_LINK_BUTTONS_PER_ROW, Math.trunc(value)));
}
