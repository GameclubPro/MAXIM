import { createHash } from 'node:crypto';
import { extractUrlsFromText, stripUrlsFromText } from '../common/url-text.util';

const COMMERCIAL_CAMPAIGN_KEY_PREFIX = 'commercial-campaign:v1';
const COMMERCIAL_CAMPAIGN_PHONE_PATTERN = /(?:\+?\d[\d\s()\-]{8,}\d)/gu;
const COMMERCIAL_CAMPAIGN_TEXT_MIN_LENGTH = 18;
const COMMERCIAL_CAMPAIGN_TEXT_MIN_TOKENS = 3;

export const COMMERCIAL_CAMPAIGN_WINDOW_SEC = 36 * 60 * 60;
export const COMMERCIAL_CAMPAIGN_MAX_LINKS = 2;
export const COMMERCIAL_CAMPAIGN_MAX_PHONES = 2;

export type CommercialCampaignFingerprint = {
  normalizedText: string;
  textHash: string | null;
  links: string[];
  phones: string[];
};

export type CommercialCampaignContext = {
  senderDistinctChatCount: number;
  sameTextDistinctChatCount: number;
  repeatedPhoneDistinctChatCount: number;
  repeatedLinkDistinctChatCount: number;
};

type InMemoryExpiringSet = {
  expiresAtMs: number;
  members: Set<string>;
};

function hashCampaignKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function normalizeCampaignText(value: string): string {
  let normalized = stripUrlsFromText(value.toLowerCase());
  normalized = normalized.replace(COMMERCIAL_CAMPAIGN_PHONE_PATTERN, ' ');
  normalized = normalized.replace(/ё/g, 'е');
  normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
  normalized = normalized.replace(/[_*~`"'«»“”(){}[\]|]+/gu, ' ');
  normalized = normalized.replace(/[^\p{L}\p{N}\s%+-]+/gu, ' ');
  normalized = normalized.replace(/\s+/gu, ' ').trim();
  return normalized;
}

export function normalizeCommercialCampaignSenderId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCommercialCampaignPhone(value: string): string | null {
  const digits = value.replace(/\D+/gu, '');
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }

  if (digits.length === 11 && digits.startsWith('8')) {
    return `7${digits.slice(1)}`;
  }

  return digits;
}

export function extractCommercialCampaignPhones(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const phones: string[] = [];

  for (const match of value.matchAll(COMMERCIAL_CAMPAIGN_PHONE_PATTERN)) {
    const normalized = normalizeCommercialCampaignPhone(match[0]);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    phones.push(normalized);
    if (phones.length >= COMMERCIAL_CAMPAIGN_MAX_PHONES) {
      break;
    }
  }

  return phones;
}

export function normalizeCommercialCampaignUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) {
      return null;
    }

    const pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    return `${hostname}${pathname === '/' ? '' : pathname}`;
  } catch {
    return null;
  }
}

export function extractCommercialCampaignLinks(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const links: string[] = [];

  for (const rawLink of extractUrlsFromText(value)) {
    const normalized = normalizeCommercialCampaignUrl(rawLink);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    links.push(normalized);
    if (links.length >= COMMERCIAL_CAMPAIGN_MAX_LINKS) {
      break;
    }
  }

  return links;
}

export function buildCommercialCampaignFingerprint(value: string): CommercialCampaignFingerprint {
  const normalizedText = normalizeCampaignText(value);
  const tokenCount = normalizedText.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const textHash =
    normalizedText.length >= COMMERCIAL_CAMPAIGN_TEXT_MIN_LENGTH &&
    tokenCount >= COMMERCIAL_CAMPAIGN_TEXT_MIN_TOKENS
      ? createHash('sha256').update(normalizedText).digest('hex').slice(0, 20)
      : null;

  return {
    normalizedText,
    textHash,
    links: extractCommercialCampaignLinks(value),
    phones: extractCommercialCampaignPhones(value),
  };
}

export function hasCommercialCampaignEvidence(
  value: CommercialCampaignContext | null | undefined,
): value is CommercialCampaignContext {
  return Boolean(
    value &&
      (value.sameTextDistinctChatCount >= 2 ||
        value.repeatedPhoneDistinctChatCount >= 2 ||
        value.repeatedLinkDistinctChatCount >= 2 ||
        value.senderDistinctChatCount >= 3),
  );
}

export function buildCommercialCampaignSenderChatsKey(senderId: string): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:sender:${hashCampaignKeyPart(senderId)}:chats`;
}

export function buildCommercialCampaignSenderTextChatsKey(
  senderId: string,
  textHash: string,
): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:sender:${hashCampaignKeyPart(senderId)}:text:${textHash}:chats`;
}

export function buildCommercialCampaignPhoneChatsKey(phone: string): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:phone:${hashCampaignKeyPart(phone)}:chats`;
}

export function buildCommercialCampaignLinkChatsKey(link: string): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:link:${hashCampaignKeyPart(link)}:chats`;
}

export class InMemoryCommercialCampaignTracker {
  private readonly sets = new Map<string, InMemoryExpiringSet>();

  constructor(private readonly ttlSec = COMMERCIAL_CAMPAIGN_WINDOW_SEC) {}

  track(params: {
    createdAt: Date;
    chatId: string;
    senderId: string;
    text: string;
  }): CommercialCampaignContext | null {
    const normalizedSenderId = normalizeCommercialCampaignSenderId(params.senderId);
    if (!normalizedSenderId) {
      return null;
    }

    const createdAtMs = params.createdAt.getTime();
    const fingerprint = buildCommercialCampaignFingerprint(params.text);
    const senderDistinctChatCount = this.addToSetWithTtl(
      buildCommercialCampaignSenderChatsKey(normalizedSenderId),
      params.chatId,
      createdAtMs,
    );
    const sameTextDistinctChatCount = fingerprint.textHash
      ? this.addToSetWithTtl(
          buildCommercialCampaignSenderTextChatsKey(normalizedSenderId, fingerprint.textHash),
          params.chatId,
          createdAtMs,
        )
      : 0;

    let repeatedPhoneDistinctChatCount = 0;
    for (const phone of fingerprint.phones) {
      repeatedPhoneDistinctChatCount = Math.max(
        repeatedPhoneDistinctChatCount,
        this.addToSetWithTtl(buildCommercialCampaignPhoneChatsKey(phone), params.chatId, createdAtMs),
      );
    }

    let repeatedLinkDistinctChatCount = 0;
    for (const link of fingerprint.links) {
      repeatedLinkDistinctChatCount = Math.max(
        repeatedLinkDistinctChatCount,
        this.addToSetWithTtl(buildCommercialCampaignLinkChatsKey(link), params.chatId, createdAtMs),
      );
    }

    return {
      senderDistinctChatCount,
      sameTextDistinctChatCount,
      repeatedPhoneDistinctChatCount,
      repeatedLinkDistinctChatCount,
    };
  }

  private addToSetWithTtl(key: string, member: string, createdAtMs: number): number {
    const existing = this.sets.get(key);
    if (!existing || existing.expiresAtMs <= createdAtMs) {
      const next: InMemoryExpiringSet = {
        expiresAtMs: createdAtMs + this.ttlSec * 1000,
        members: new Set([member]),
      };
      this.sets.set(key, next);
      return next.members.size;
    }

    existing.members.add(member);
    return existing.members.size;
  }
}
