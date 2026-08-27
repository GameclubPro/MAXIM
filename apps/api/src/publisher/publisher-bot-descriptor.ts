export const DEFAULT_MAX_PUBLISHER_BOT_ID = 'se14088825_bot';
export const DEFAULT_MAX_PUBLISHER_BOT_CONTACT_ID = '387541327';
export const DEFAULT_MAX_PUBLISHER_BOT_LABEL = 'Публик';

export type PublisherBotDescriptor = Readonly<{
  id: string;
  contactId: string | null;
  label: string;
  kind: 'publisher';
}>;

export function buildPublisherBotDescriptor(
  input: {
    id?: string | null;
    label?: string | null;
  } = {},
): PublisherBotDescriptor {
  const id = input.id?.trim() || DEFAULT_MAX_PUBLISHER_BOT_ID;
  const label = input.label?.trim() || DEFAULT_MAX_PUBLISHER_BOT_LABEL;
  const contactId =
    id === DEFAULT_MAX_PUBLISHER_BOT_ID ? DEFAULT_MAX_PUBLISHER_BOT_CONTACT_ID : null;

  return Object.freeze({ id, contactId, label, kind: 'publisher' as const });
}

export function isPublisherBotId(
  value: string | null | undefined,
  configuredBotId = DEFAULT_MAX_PUBLISHER_BOT_ID,
): boolean {
  return typeof value === 'string' && value.trim() === configuredBotId.trim();
}
