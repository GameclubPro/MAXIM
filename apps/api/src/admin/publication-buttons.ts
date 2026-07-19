import {
  MAX_PUBLICATION_BUTTONS,
  publicationButtonSchema,
  type PublicationButton,
} from '@maxim/contracts/publication';

export function readStoredPublicationButtons(value: unknown): PublicationButton[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const buttons: PublicationButton[] = [];
  for (const item of value) {
    const parsed = publicationButtonSchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }
    buttons.push(parsed.data);
    if (buttons.length >= MAX_PUBLICATION_BUTTONS) {
      break;
    }
  }
  return buttons;
}
