import { z } from 'zod';

export const DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES = 0.5;
export const DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES = 60;
export const DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES = 2;
export const DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES = Object.freeze([
  DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES,
  ...Array.from({ length: DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES }, (_, index) => index + 1),
]);

export function isValidDeleteBotMessagesDelayMinutes(value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }

  return DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.some(
    (candidate) => Math.abs(candidate - value) < 1e-9,
  );
}

export function normalizeDeleteBotMessagesDelayMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES;
  }

  let closest = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES[0];
  let closestDistance = Math.abs(closest - value);

  for (const candidate of DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.slice(1)) {
    const distance = Math.abs(candidate - value);
    if (distance < closestDistance || (distance === closestDistance && candidate > closest)) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return closest;
}

export function stepDeleteBotMessagesDelayMinutes(value: number, direction: number): number {
  const normalized = normalizeDeleteBotMessagesDelayMinutes(value);
  const currentIndex = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.findIndex(
    (candidate) => Math.abs(candidate - normalized) < 1e-9,
  );
  if (currentIndex < 0) {
    return normalized;
  }

  const nextIndex = Math.min(
    DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.length - 1,
    Math.max(0, currentIndex + Math.sign(direction)),
  );

  return DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES[nextIndex] ?? normalized;
}

export function formatDeleteBotMessagesDelayLabel(value: number): string {
  const normalized = normalizeDeleteBotMessagesDelayMinutes(value);
  if (normalized < 1) {
    return '30 сек';
  }

  return `${normalized} мин`;
}

const ALLOWLIST_URL_CANDIDATE_PATTERN =
  /(?:https?:\/\/|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,24}|рф))[^\s<>"'()[\]{}]*/iu;
const ALLOWLIST_BARE_WEB_TARGET_PATTERN =
  /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,24}|рф)(?::\d{1,5})?(?:[/?#]|$)/iu;
const ALLOWLIST_TRAILING_URL_PUNCTUATION = new Set([')', ']', '}', ',', '.', ';', '!', '?', ':']);
const ENCODED_WHITESPACE_PATTERN = /%(?:09|0a|0d|20)/i;
export const ALLOWLIST_DOMAIN_RULE_PREFIX = 'domain:';
export const ALLOWLIST_MAX_PROFILE_RULE_PREFIX = 'max-profile:';
export const ALLOWLIST_MAX_ENTITY_RULE_PREFIX = 'max-entity:';
export const ALLOWLIST_MINI_APP_RULE_PREFIX = 'mini-app:';
export const allowlistMatchTypeSchema = z.enum(['EXACT', 'DOMAIN']);
export type AllowlistMatchType = z.infer<typeof allowlistMatchTypeSchema>;
export const navigationAllowlistKindSchema = z.enum([
  'WEB_EXACT',
  'WEB_DOMAIN',
  'MAX_PROFILE',
  'MAX_ENTITY',
  'MINI_APP',
]);
export type NavigationAllowlistKind = z.infer<typeof navigationAllowlistKindSchema>;
export const navigationAllowlistInputKindSchema = z.union([
  navigationAllowlistKindSchema,
  allowlistMatchTypeSchema,
]);
export type NavigationAllowlistInputKind = z.infer<typeof navigationAllowlistInputKindSchema>;

export type ParsedStoredAllowlistEntry = {
  domain: string;
  target: string;
  normalizedValue: string;
  matchType: AllowlistMatchType;
  kind: NavigationAllowlistKind;
};

export const navigationAllowlistEvidenceKindSchema = z.enum([
  'external_url',
  'max_entity',
  'profile_mention',
  'mini_app',
]);
export type NavigationAllowlistEvidenceKind = z.infer<typeof navigationAllowlistEvidenceKindSchema>;
export type NavigationAllowlistPolicyKey = {
  kind: NavigationAllowlistKind;
  target: string;
};

const MAX_PROFILE_USER_ID_TARGET_PREFIX = 'user-id:';
const MAX_PROFILE_USERNAME_TARGET_PREFIX = 'username:';
const MAX_ENTITY_CHAT_ID_TARGET_PREFIX = 'chat-id:';
const MAX_ENTITY_CHAT_UUID_TARGET_PREFIX = 'chat-uuid:';
const MAX_ENTITY_OBSERVED_CHAT_UUID_TARGET_PREFIX = 'chat_uuid:';
const MAX_ENTITY_CHAT_CREATE_TARGET = 'chat-create';
const MAX_ENTITY_URL_TARGET_PREFIX = 'url:';
const MINI_APP_BOT_TARGET_PREFIX = 'bot:';
const MINI_APP_CONTACT_ID_TARGET_PREFIX = 'contact-id:';
const MINI_APP_OBSERVED_CONTACT_ID_TARGET_PREFIX = 'contact_id:';
const MINI_APP_URL_TARGET_PREFIX = 'url:';
const MAX_NAVIGATION_TARGET_MAX_LENGTH = 1_024;
export const NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH = 2_048;
const MAX_NAVIGATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const MAX_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{1,63}$/u;
const MAX_PROFILE_USER_ID_PATTERN = /^[1-9]\d{0,19}$/u;
const MAX_STARTAPP_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const MAX_ENTITY_CHAT_ID_PATTERN = /^-?\d{1,40}$/u;
const MAX_ENTITY_PATH_ROOTS = new Set(['c', 'channel', 'channels', 'chat', 'chats', 'join']);
const MAX_RESERVED_SINGLE_SEGMENT_PATHS = new Set([...MAX_ENTITY_PATH_ROOTS, 'help', 'settings']);

type ParsedAllowlistCandidate = {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
};

function tryDecodeUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function trimAllowlistTrailingUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && ALLOWLIST_TRAILING_URL_PUNCTUATION.has(value[end - 1] ?? '')) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function extractAllowlistUrlCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const decoded = tryDecodeUriComponent(trimmed);
  const candidates =
    decoded && decoded !== trimmed && ENCODED_WHITESPACE_PATTERN.test(trimmed)
      ? [decoded, trimmed]
      : decoded && decoded !== trimmed
        ? [trimmed, decoded]
        : [trimmed];

  for (const candidate of candidates) {
    const match = candidate.match(ALLOWLIST_URL_CANDIDATE_PATTERN);
    if (!match) {
      continue;
    }

    const extracted = trimAllowlistTrailingUrlPunctuation(match[0]);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function canonicalizeAllowlistHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function parseAllowlistCandidate(value: string): ParsedAllowlistCandidate | null {
  const raw = extractAllowlistUrlCandidate(value);
  if (!raw) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    return null;
  }

  const hostname = canonicalizeAllowlistHostname(parsed.hostname);
  if (!hostname) {
    return null;
  }

  return {
    protocol,
    hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

function parseStrictWebAllowlistCandidate(value: string): ParsedAllowlistCandidate | null {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH ||
    hasNavigationTargetWhitespaceOrControl(normalized)
  ) {
    return null;
  }

  const hasScheme = /^https?:\/\//iu.test(normalized);
  if (!hasScheme && !ALLOWLIST_BARE_WEB_TARGET_PATTERN.test(normalized)) {
    return null;
  }

  const withScheme = hasScheme ? normalized : `https://${normalized}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (
    (protocol !== 'https:' && protocol !== 'http:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return null;
  }

  const hostname = canonicalizeAllowlistHostname(parsed.hostname);
  if (!hostname) {
    return null;
  }

  return {
    protocol,
    hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

function formatNormalizedAllowlistLink(parsed: ParsedAllowlistCandidate): string {
  const shouldKeepPort =
    parsed.port.length > 0 &&
    !(
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    );
  const port = shouldKeepPort ? `:${parsed.port}` : '';
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;

  return `${parsed.protocol}//${parsed.hostname}${port}${pathname}${parsed.search}${parsed.hash}`;
}

export function normalizeAllowlistLink(value: string): string | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }
  return formatNormalizedAllowlistLink(parsed);
}

function normalizeStrictWebAllowlistLink(value: string): string | null {
  const parsed = parseStrictWebAllowlistCandidate(value);
  return parsed ? formatNormalizedAllowlistLink(parsed) : null;
}

export function normalizeAllowlistDomain(value: string): string | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  return parsed.hostname;
}

export function inferAllowlistMatchType(value: string): AllowlistMatchType | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    return 'EXACT';
  }

  return 'DOMAIN';
}

export function resolveNavigationAllowlistKind(
  value: NavigationAllowlistInputKind,
): NavigationAllowlistKind {
  if (value === 'EXACT') {
    return 'WEB_EXACT';
  }
  if (value === 'DOMAIN') {
    return 'WEB_DOMAIN';
  }
  return value;
}

export function resolveLegacyAllowlistMatchType(kind: NavigationAllowlistKind): AllowlistMatchType {
  return kind === 'WEB_DOMAIN' ? 'DOMAIN' : 'EXACT';
}

function hasNavigationTargetWhitespaceOrControl(value: string): boolean {
  return /[\s\p{Cc}\p{Cf}]/u.test(value);
}

function normalizeMaxProfileIdentity(value: string): string | null {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_NAVIGATION_TARGET_MAX_LENGTH ||
    hasNavigationTargetWhitespaceOrControl(normalized)
  ) {
    return null;
  }

  if (normalized.toLowerCase().startsWith(MAX_PROFILE_USER_ID_TARGET_PREFIX)) {
    const userId = normalized.slice(MAX_PROFILE_USER_ID_TARGET_PREFIX.length);
    return MAX_PROFILE_USER_ID_PATTERN.test(userId)
      ? `${MAX_PROFILE_USER_ID_TARGET_PREFIX}${userId}`
      : null;
  }

  if (normalized.toLowerCase().startsWith(MAX_PROFILE_USERNAME_TARGET_PREFIX)) {
    const username = normalized.slice(MAX_PROFILE_USERNAME_TARGET_PREFIX.length);
    return MAX_USERNAME_PATTERN.test(username)
      ? `${MAX_PROFILE_USERNAME_TARGET_PREFIX}${username.toLowerCase()}`
      : null;
  }

  const maxUserMatch = normalized.match(/^max:\/\/user\/([^/?#]+)$/iu);
  const userLinkMatch = normalized.match(/^\/?user\/([^/?#]+)$/iu);
  const encodedUserId = maxUserMatch?.[1] ?? userLinkMatch?.[1] ?? null;
  if (encodedUserId) {
    const userId = tryDecodeUriComponent(encodedUserId);
    return userId && MAX_PROFILE_USER_ID_PATTERN.test(userId)
      ? `${MAX_PROFILE_USER_ID_TARGET_PREFIX}${userId}`
      : null;
  }

  if (MAX_PROFILE_USER_ID_PATTERN.test(normalized)) {
    return `${MAX_PROFILE_USER_ID_TARGET_PREFIX}${normalized}`;
  }

  const username = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  if (!MAX_USERNAME_PATTERN.test(username)) {
    return null;
  }

  return `${MAX_PROFILE_USERNAME_TARGET_PREFIX}${username.toLowerCase()}`;
}

function normalizeMaxHost(parsed: URL): boolean {
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
    return false;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0
  ) {
    return false;
  }

  parsed.protocol = 'https:';
  parsed.hostname = 'max.ru';
  return true;
}

function parseStrictUrl(value: string): URL | null {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_NAVIGATION_TARGET_MAX_LENGTH ||
    hasNavigationTargetWhitespaceOrControl(normalized)
  ) {
    return null;
  }

  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function normalizeMaxEntityTarget(value: string): string | null {
  const normalized = value.trim();
  if (normalized.toLowerCase().startsWith(MAX_ENTITY_CHAT_ID_TARGET_PREFIX)) {
    const chatId = normalized.slice(MAX_ENTITY_CHAT_ID_TARGET_PREFIX.length);
    if (!MAX_ENTITY_CHAT_ID_PATTERN.test(chatId)) {
      return null;
    }
    return `${MAX_ENTITY_CHAT_ID_TARGET_PREFIX}${BigInt(chatId).toString()}`;
  }

  if (MAX_ENTITY_CHAT_ID_PATTERN.test(normalized)) {
    return `${MAX_ENTITY_CHAT_ID_TARGET_PREFIX}${BigInt(normalized).toString()}`;
  }

  const rawUrl = normalized.toLowerCase().startsWith(MAX_ENTITY_URL_TARGET_PREFIX)
    ? normalized.slice(MAX_ENTITY_URL_TARGET_PREFIX.length)
    : normalized;
  const parsed = parseStrictUrl(rawUrl);
  if (!parsed || !normalizeMaxHost(parsed) || parsed.hash.length > 0) {
    return null;
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const root = pathSegments[0]?.toLowerCase() ?? '';
  if (pathSegments.length < 2 || !MAX_ENTITY_PATH_ROOTS.has(root)) {
    return null;
  }

  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return `${MAX_ENTITY_URL_TARGET_PREFIX}${parsed.toString()}`;
}

function normalizeObservedMaxChatActionTarget(value: string): string | null {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  const chatUuidPrefix = lower.startsWith(MAX_ENTITY_CHAT_UUID_TARGET_PREFIX)
    ? MAX_ENTITY_CHAT_UUID_TARGET_PREFIX
    : lower.startsWith(MAX_ENTITY_OBSERVED_CHAT_UUID_TARGET_PREFIX)
      ? MAX_ENTITY_OBSERVED_CHAT_UUID_TARGET_PREFIX
      : null;
  if (chatUuidPrefix) {
    const chatUuid = normalized.slice(chatUuidPrefix.length);
    return MAX_NAVIGATION_ID_PATTERN.test(chatUuid)
      ? `${MAX_ENTITY_CHAT_UUID_TARGET_PREFIX}${chatUuid}`
      : null;
  }
  return lower === MAX_ENTITY_CHAT_CREATE_TARGET ? MAX_ENTITY_CHAT_CREATE_TARGET : null;
}

function normalizeMiniAppTarget(value: string): string | null {
  const normalized = value.trim();
  if (normalized.toLowerCase().startsWith(MINI_APP_BOT_TARGET_PREFIX)) {
    const bot = normalized.slice(MINI_APP_BOT_TARGET_PREFIX.length);
    return MAX_NAVIGATION_ID_PATTERN.test(bot) &&
      !MAX_RESERVED_SINGLE_SEGMENT_PATHS.has(bot.toLowerCase())
      ? `${MINI_APP_BOT_TARGET_PREFIX}${bot.toLowerCase()}`
      : null;
  }

  const lower = normalized.toLowerCase();
  const contactIdPrefix = lower.startsWith(MINI_APP_CONTACT_ID_TARGET_PREFIX)
    ? MINI_APP_CONTACT_ID_TARGET_PREFIX
    : lower.startsWith(MINI_APP_OBSERVED_CONTACT_ID_TARGET_PREFIX)
      ? MINI_APP_OBSERVED_CONTACT_ID_TARGET_PREFIX
      : null;
  if (contactIdPrefix) {
    const contactId = normalized.slice(contactIdPrefix.length);
    return MAX_NAVIGATION_ID_PATTERN.test(contactId)
      ? `${MINI_APP_CONTACT_ID_TARGET_PREFIX}${contactId}`
      : null;
  }

  const publicBotUsername = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  if (
    MAX_USERNAME_PATTERN.test(publicBotUsername) &&
    !MAX_RESERVED_SINGLE_SEGMENT_PATHS.has(publicBotUsername.toLowerCase())
  ) {
    return `${MINI_APP_BOT_TARGET_PREFIX}${publicBotUsername.toLowerCase()}`;
  }

  const rawUrl = normalized.toLowerCase().startsWith(MINI_APP_URL_TARGET_PREFIX)
    ? normalized.slice(MINI_APP_URL_TARGET_PREFIX.length)
    : normalized;
  const parsed = parseStrictUrl(rawUrl);
  if (
    !parsed ||
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return null;
  }

  const isMaxHost = ['max.ru', 'www.max.ru'].includes(parsed.hostname.toLowerCase());
  if (isMaxHost) {
    if (!normalizeMaxHost(parsed)) {
      return null;
    }

    const startAppValues = parsed.searchParams.getAll('startapp');
    if (startAppValues.length > 0) {
      const pathSegments = parsed.pathname.split('/').filter(Boolean);
      const bot = pathSegments.length === 1 ? tryDecodeUriComponent(pathSegments[0] ?? '') : null;
      if (
        !bot ||
        !MAX_NAVIGATION_ID_PATTERN.test(bot) ||
        MAX_RESERVED_SINGLE_SEGMENT_PATHS.has(bot.toLowerCase()) ||
        startAppValues.length !== 1 ||
        !MAX_STARTAPP_PAYLOAD_PATTERN.test(startAppValues[0] ?? '') ||
        parsed.hash.length > 0
      ) {
        return null;
      }

      return `${MINI_APP_BOT_TARGET_PREFIX}${bot.toLowerCase()}`;
    }
  }

  return `${MINI_APP_URL_TARGET_PREFIX}${parsed.toString()}`;
}

export function normalizeNavigationAllowlistTarget(
  value: string,
  inputKind: NavigationAllowlistInputKind,
): string | null {
  const kind = resolveNavigationAllowlistKind(inputKind);
  switch (kind) {
    case 'WEB_EXACT':
      return normalizeStrictWebAllowlistLink(value);
    case 'WEB_DOMAIN':
      return normalizeAllowlistDomain(value);
    case 'MAX_PROFILE':
      return normalizeMaxProfileIdentity(value);
    case 'MAX_ENTITY':
      return normalizeMaxEntityTarget(value);
    case 'MINI_APP':
      return normalizeMiniAppTarget(value);
  }
}

function serializeTypedAllowlistEntry(prefix: string, target: string): string | null {
  const serialized = `${prefix}${encodeURIComponent(target)}`;
  return serialized.length <= NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH ? serialized : null;
}

export function normalizeStoredNavigationAllowlistEntry(
  value: string,
  inputKind: NavigationAllowlistInputKind,
): string | null {
  const kind = resolveNavigationAllowlistKind(inputKind);
  const target =
    kind === 'WEB_EXACT'
      ? (normalizeNavigationAllowlistTarget(value, kind) ??
        (inputKind === 'EXACT' ? normalizeAllowlistLink(value) : null))
      : normalizeNavigationAllowlistTarget(value, kind);
  if (!target) {
    return null;
  }
  if (kind === 'MAX_PROFILE' && target.startsWith(MAX_PROFILE_USERNAME_TARGET_PREFIX)) {
    return null;
  }
  if (kind === 'MAX_ENTITY' && target.startsWith(MAX_ENTITY_CHAT_ID_TARGET_PREFIX)) {
    return null;
  }

  switch (kind) {
    case 'WEB_EXACT':
      return target.length <= NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH ? target : null;
    case 'WEB_DOMAIN':
      return `${ALLOWLIST_DOMAIN_RULE_PREFIX}${target}`;
    case 'MAX_PROFILE':
      return serializeTypedAllowlistEntry(ALLOWLIST_MAX_PROFILE_RULE_PREFIX, target);
    case 'MAX_ENTITY':
      return serializeTypedAllowlistEntry(ALLOWLIST_MAX_ENTITY_RULE_PREFIX, target);
    case 'MINI_APP':
      return serializeTypedAllowlistEntry(ALLOWLIST_MINI_APP_RULE_PREFIX, target);
  }
}

export function normalizeStoredAllowlistEntry(
  value: string,
  matchType: NavigationAllowlistInputKind,
): string | null {
  return normalizeStoredNavigationAllowlistEntry(value, matchType);
}

function pushNavigationAllowlistPolicyKey(
  keys: NavigationAllowlistPolicyKey[],
  kind: NavigationAllowlistKind,
  target: string | null,
): void {
  if (!target || keys.some((key) => key.kind === kind && key.target === target)) {
    return;
  }
  keys.push({ kind, target });
}

export function buildNavigationAllowlistPolicyKeys(
  value: string,
  evidenceKind: NavigationAllowlistEvidenceKind,
): NavigationAllowlistPolicyKey[] {
  const keys: NavigationAllowlistPolicyKey[] = [];

  if (evidenceKind === 'max_entity') {
    pushNavigationAllowlistPolicyKey(
      keys,
      'MAX_ENTITY',
      normalizeNavigationAllowlistTarget(value, 'MAX_ENTITY') ??
        normalizeObservedMaxChatActionTarget(value),
    );
    return keys;
  }

  if (evidenceKind === 'profile_mention') {
    pushNavigationAllowlistPolicyKey(
      keys,
      'MAX_PROFILE',
      normalizeNavigationAllowlistTarget(value, 'MAX_PROFILE'),
    );
    return keys;
  }

  if (evidenceKind === 'mini_app') {
    pushNavigationAllowlistPolicyKey(
      keys,
      'MINI_APP',
      normalizeNavigationAllowlistTarget(value, 'MINI_APP'),
    );
    pushNavigationAllowlistPolicyKey(
      keys,
      'WEB_EXACT',
      normalizeNavigationAllowlistTarget(value, 'WEB_EXACT'),
    );
    pushNavigationAllowlistPolicyKey(
      keys,
      'WEB_DOMAIN',
      normalizeNavigationAllowlistTarget(value, 'WEB_DOMAIN'),
    );
    return keys;
  }

  pushNavigationAllowlistPolicyKey(
    keys,
    'WEB_EXACT',
    normalizeNavigationAllowlistTarget(value, 'WEB_EXACT'),
  );
  pushNavigationAllowlistPolicyKey(
    keys,
    'WEB_DOMAIN',
    normalizeNavigationAllowlistTarget(value, 'WEB_DOMAIN'),
  );

  // An official MAX startapp route is a mini app before it can be treated as a generic entity URL.
  const miniAppTarget = normalizeNavigationAllowlistTarget(value, 'MINI_APP');
  if (miniAppTarget?.startsWith(MINI_APP_BOT_TARGET_PREFIX)) {
    pushNavigationAllowlistPolicyKey(keys, 'MINI_APP', miniAppTarget);
    return keys;
  }

  pushNavigationAllowlistPolicyKey(
    keys,
    'MAX_ENTITY',
    normalizeNavigationAllowlistTarget(value, 'MAX_ENTITY'),
  );
  return keys;
}

function parseTypedStoredAllowlistEntry(
  value: string,
  prefix: string,
  kind: Extract<NavigationAllowlistKind, 'MAX_PROFILE' | 'MAX_ENTITY' | 'MINI_APP'>,
): ParsedStoredAllowlistEntry | null {
  const encodedTarget = value.slice(prefix.length);
  const decodedTarget = tryDecodeUriComponent(encodedTarget);
  if (!decodedTarget) {
    return null;
  }

  const target = normalizeNavigationAllowlistTarget(decodedTarget, kind);
  if (!target) {
    return null;
  }
  const normalizedValue = serializeTypedAllowlistEntry(prefix, target);
  if (!normalizedValue) {
    return null;
  }

  return {
    domain: target,
    target,
    normalizedValue,
    matchType: 'EXACT',
    kind,
  };
}

export function parseStoredAllowlistEntry(value: string): ParsedStoredAllowlistEntry | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith(ALLOWLIST_MAX_PROFILE_RULE_PREFIX)) {
    return parseTypedStoredAllowlistEntry(
      trimmed,
      ALLOWLIST_MAX_PROFILE_RULE_PREFIX,
      'MAX_PROFILE',
    );
  }
  if (lower.startsWith(ALLOWLIST_MAX_ENTITY_RULE_PREFIX)) {
    return parseTypedStoredAllowlistEntry(trimmed, ALLOWLIST_MAX_ENTITY_RULE_PREFIX, 'MAX_ENTITY');
  }
  if (lower.startsWith(ALLOWLIST_MINI_APP_RULE_PREFIX)) {
    return parseTypedStoredAllowlistEntry(trimmed, ALLOWLIST_MINI_APP_RULE_PREFIX, 'MINI_APP');
  }

  if (lower.startsWith(ALLOWLIST_DOMAIN_RULE_PREFIX)) {
    const normalizedDomain = normalizeAllowlistDomain(
      trimmed.slice(ALLOWLIST_DOMAIN_RULE_PREFIX.length),
    );
    if (!normalizedDomain) {
      return null;
    }

    return {
      domain: normalizedDomain,
      target: normalizedDomain,
      normalizedValue: `${ALLOWLIST_DOMAIN_RULE_PREFIX}${normalizedDomain}`,
      matchType: 'DOMAIN',
      kind: 'WEB_DOMAIN',
    };
  }

  const normalizedLink =
    normalizeNavigationAllowlistTarget(trimmed, 'WEB_EXACT') ?? normalizeAllowlistLink(trimmed);
  if (!normalizedLink) {
    return null;
  }

  return {
    domain: normalizedLink,
    target: normalizedLink,
    normalizedValue: normalizedLink,
    matchType: 'EXACT',
    kind: 'WEB_EXACT',
  };
}
