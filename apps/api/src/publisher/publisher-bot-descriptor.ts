export const DEFAULT_MAX_PUBLISHER_BOT_ID = 'se14088825_bot';
export const DEFAULT_MAX_PUBLISHER_BOT_LABEL = 'Публик';

export type PublisherBotDescriptor = Readonly<{
  id: string;
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

  return Object.freeze({ id, label, kind: 'publisher' as const });
}

export function isPublisherBotId(
  value: string | null | undefined,
  configuredBotId = DEFAULT_MAX_PUBLISHER_BOT_ID,
): boolean {
  return typeof value === 'string' && value.trim() === configuredBotId.trim();
}
