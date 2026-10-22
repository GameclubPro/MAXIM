import { z } from 'zod';
import { MAX_HTTP_BUTTON_URL_LENGTH, normalizeHttpButtonUrl } from './button-url.js';
import { DEFAULT_BROADCAST_BUTTON_TEXT } from './broadcast-common.js';

export const botButtonUrlSchema = z.string().trim().max(MAX_HTTP_BUTTON_URL_LENGTH).default('');

export const botButtonTextSchema = z.string().trim().max(32).default(DEFAULT_BROADCAST_BUTTON_TEXT);

export const MAX_BOT_SPEECH_TEXT_LENGTH = 1_000;

export const botMessageTextSchema = z.string().max(MAX_BOT_SPEECH_TEXT_LENGTH).default('');

export function parseHttpButtonUrl(value: string): URL | null {
  const normalized = normalizeHttpButtonUrl(value);
  return normalized ? new URL(normalized) : null;
}

function isProfileHandoffStartPayload(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('pmh-') || normalized.startsWith('pm2_');
}

export function isValidBotButtonUrl(value: string): boolean {
  const parsed = parseHttpButtonUrl(value);
  if (!parsed) {
    return false;
  }

  return !isProfileHandoffStartPayload(parsed.searchParams.get('start') ?? '');
}

export function isValidBotButtonText(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 32;
}
