import { isDeepStrictEqual } from 'node:util';
import type { MaxMessageButton } from './max-client.service';
import { readStrictEditableAttachments } from './max-editable-message-preservation';
import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';

export type MaxInlineKeyboardTextRefresh = {
  button: MaxMessageButton;
  readText: () => Promise<string>;
};

export async function refreshExistingInlineKeyboardText(
  message: Record<string, unknown> | null,
  refresh: MaxInlineKeyboardTextRefresh,
): Promise<Record<string, unknown> | null> {
  const attachments = readStrictEditableAttachments(message, false);
  const target = normalizeMaxInlineKeyboardButtons([[refresh.button]])?.[0]?.[0];
  if (!target) return null;
  const targetIdentity = { ...target, text: undefined };
  const matches = (value: unknown) => {
    const button = normalizeMaxInlineKeyboardButtons([[value]])?.[0]?.[0];
    if (!button) return false;
    return isDeepStrictEqual({ ...button, text: undefined }, targetIdentity);
  };
  const targets: Record<string, unknown>[] = [];
  const clonedAttachments = attachments.map((value) => {
    const attachment = value as Record<string, unknown> | null;
    if (attachment?.type !== 'inline_keyboard') return value;
    const payload = attachment.payload as { buttons?: unknown } | null;
    if (!Array.isArray(payload?.buttons)) return value;
    const buttons = payload.buttons.map((row: unknown) =>
      !Array.isArray(row)
        ? row
        : row.map((button: unknown) => {
            if (!matches(button)) return button;
            const updated = { ...(button as Record<string, unknown>) };
            targets.push(updated);
            return updated;
          }),
    );
    return { ...attachment, payload: { ...payload, buttons } };
  });
  // FLAG: A counter refresh cannot recreate a removed link or adopt another discussion.
  if (targets.length === 0) return null;
  const text = await refresh.readText();
  if (targets.every((button) => button.text === text)) return null;
  for (const button of targets) button.text = text;
  return { ...message, body: { ...(message?.body as object), attachments: clonedAttachments } };
}
