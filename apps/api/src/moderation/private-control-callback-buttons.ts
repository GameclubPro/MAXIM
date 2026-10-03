import type { MaxMessageButton } from '../max/max-client.service';
import { MAX_CALLBACK_PREFIX } from './private-control.constants';
import { compactPrivateText } from './private-control-launcher-renderer';

// FLAG: Existing private messages persist these payloads; preserve the prefix and argument order.
export function buildPrivateCallbackPayload(action: string, ...args: string[]): string {
  const filtered = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  return [MAX_CALLBACK_PREFIX, action, ...filtered].join('|');
}

export function buildPrivateCallbackButton(
  text: string,
  payload: string,
  intent: 'default' | 'positive' | 'negative' = 'default',
): MaxMessageButton {
  return { type: 'callback', text: compactPrivateText(text, 48), payload, intent };
}
