import {
  broadcastLinkButtonSchema,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  type BroadcastLinkButton,
} from '@maxim/contracts/broadcast';

export type BroadcastLinkButtonFieldErrors = {
  text?: string;
  url?: string;
};

export function createEmptyBroadcastLinkButton(): BroadcastLinkButton {
  return {
    text: DEFAULT_BROADCAST_BUTTON_TEXT,
    url: '',
  };
}

export function trimBroadcastLinkButtons(buttons: BroadcastLinkButton[]): BroadcastLinkButton[] {
  return buttons.map((button) => ({
    text: button.text.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
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
    const parsed = broadcastLinkButtonSchema.safeParse(button);

    if (
      !parsed.success &&
      parsed.error.issues.some((issue) => issue.path[0] === 'url' || issue.path.length === 0)
    ) {
      errors.url = 'Укажите корректную ссылку (http/https).';
    }

    if (
      !parsed.success &&
      parsed.error.issues.some((issue) => issue.path[0] === 'text' || issue.path.length === 0)
    ) {
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

export function chunkBroadcastLinkButtons<T>(
  buttons: T[],
  buttonsPerRow = MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
): T[][] {
  const rows: T[][] = [];
  const normalizedButtonsPerRow = Number.isFinite(buttonsPerRow)
    ? Math.min(MAX_BROADCAST_LINK_BUTTONS_PER_ROW, Math.max(1, Math.floor(buttonsPerRow)))
    : MAX_BROADCAST_LINK_BUTTONS_PER_ROW;

  for (let index = 0; index < buttons.length; index += normalizedButtonsPerRow) {
    rows.push(buttons.slice(index, index + normalizedButtonsPerRow));
  }

  return rows;
}

export function buildBroadcastPreviewButtonRows<TCustom, TSystem>(
  customButtons: TCustom[],
  systemButtons: TSystem[],
  buttonsPerRow = MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
): Array<Array<TCustom | TSystem>> {
  return [
    ...chunkBroadcastLinkButtons<TCustom | TSystem>(customButtons, buttonsPerRow),
    ...systemButtons.map((button) => [button]),
  ];
}

type BroadcastButtonPreviewLabel = Pick<BroadcastLinkButton, 'text'>;

export function formatBroadcastButtonsStatus(buttons: BroadcastButtonPreviewLabel[]): string {
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

export function formatBroadcastButtonsPreview(buttons: BroadcastButtonPreviewLabel[]): string {
  const labels = buttons.map((button) => button.text.trim()).filter((label) => label.length > 0);

  if (labels.length === 0) {
    return formatBroadcastButtonsStatus(buttons);
  }

  if (labels.length <= 2) {
    return labels.join(', ');
  }

  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

export {
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
};
