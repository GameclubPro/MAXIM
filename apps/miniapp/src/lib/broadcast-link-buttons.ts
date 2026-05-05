import {
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  type BroadcastLinkButton,
} from '@maxim/contracts';

export type BroadcastLinkButtonFieldErrors = {
  text?: string;
  url?: string;
};

export function createEmptyBroadcastLinkButton(): BroadcastLinkButton {
  return {
    text: '',
    url: '',
  };
}

export function trimBroadcastLinkButtons(buttons: BroadcastLinkButton[]): BroadcastLinkButton[] {
  return buttons.map((button) => ({
    text: button.text.trim(),
    url: button.url.trim(),
  }));
}

export function buildBroadcastLinkButtonLegacyFields(buttons: BroadcastLinkButton[]): {
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
} {
  const normalizedButtons = trimBroadcastLinkButtons(buttons);
  const primaryButton = normalizedButtons[0];

  return {
    buttons: normalizedButtons,
    buttonEnabled: normalizedButtons.length > 0,
    buttonUrl: primaryButton?.url ?? '',
    buttonText: primaryButton?.text || DEFAULT_BROADCAST_BUTTON_TEXT,
  };
}

export function validateBroadcastLinkButtons(
  buttons: BroadcastLinkButton[],
): BroadcastLinkButtonFieldErrors[] {
  return trimBroadcastLinkButtons(buttons).map((button) => {
    const errors: BroadcastLinkButtonFieldErrors = {};

    if (!isValidBroadcastLinkUrl(button.url)) {
      errors.url = 'Укажите корректную ссылку (http/https).';
    }

    if (!button.text || button.text.length > 32) {
      errors.text = 'Введите название кнопки до 32 символов.';
    }

    return errors;
  });
}

export function hasBroadcastLinkButtonErrors(errors: BroadcastLinkButtonFieldErrors[]): boolean {
  return errors.some((error) => Boolean(error.url || error.text));
}

export function clearBroadcastLinkButtonFieldError(
  errors: BroadcastLinkButtonFieldErrors[],
  index: number,
  field: keyof BroadcastLinkButtonFieldErrors,
): BroadcastLinkButtonFieldErrors[] {
  if (!errors[index]?.[field]) {
    return errors;
  }

  return errors.map((error, errorIndex) =>
    errorIndex === index ? { ...error, [field]: undefined } : error,
  );
}

export function chunkBroadcastLinkButtons<T>(buttons: T[]): T[][] {
  const rows: T[][] = [];

  for (let index = 0; index < buttons.length; index += MAX_BROADCAST_LINK_BUTTONS_PER_ROW) {
    rows.push(buttons.slice(index, index + MAX_BROADCAST_LINK_BUTTONS_PER_ROW));
  }

  return rows;
}

export function buildBroadcastPreviewButtonRows<T>(customButtons: T[], systemButtons: T[]): T[][] {
  return [...chunkBroadcastLinkButtons(customButtons), ...systemButtons.map((button) => [button])];
}

export function formatBroadcastButtonsStatus(buttons: BroadcastLinkButton[]): string {
  const count = buttons.length;
  if (count === 0) {
    return 'Нет';
  }

  if (count === 1) {
    return '1 кнопка';
  }

  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? 'кнопка'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'кнопки'
        : 'кнопок';

  return `${count} ${noun}`;
}

export {
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
};

function isValidBroadcastLinkUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
