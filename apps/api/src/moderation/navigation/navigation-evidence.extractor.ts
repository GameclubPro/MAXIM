import { MAX_HTTP_BUTTON_URL_LENGTH } from '@maxim/contracts';

import type {
  MaxNavigationAttachmentView,
  MaxNavigationButtonView,
  MaxNavigationContentView,
  MaxNavigationMarkupView,
  MaxNavigationMessageView,
  NavigationDiagnostic,
  NavigationEvidence,
  NavigationEvidenceKind,
  NavigationEvidenceRange,
  NavigationExtractionOptions,
  NavigationExtractionResult,
  PlainTextLinkCandidate,
  NavigationTargetAlias,
  NavigationTargetEvidence,
} from './navigation-evidence.types';

const KNOWN_NON_NAVIGATION_MARKUP = new Set([
  'emphasized',
  'heading',
  'highlighted',
  'monospaced',
  'quote',
  'strikethrough',
  'strong',
  'underline',
]);

const KNOWN_NON_NAVIGATION_BUTTONS = new Set([
  'callback',
  'clipboard',
  'message',
  'request_contact',
  'request_geo_location',
]);

const INBOUND_HTTP_NAVIGATION_WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;
const MAX_BOT_PATH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const MAX_STARTAPP_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const RESERVED_MAX_SINGLE_SEGMENT_PATHS = new Set([
  'c',
  'channel',
  'channels',
  'chat',
  'chats',
  'help',
  'join',
  'settings',
]);

type ExtractionState = {
  targets: NavigationTargetEvidence[];
  targetByKey: Map<string, NavigationTargetEvidence>;
  diagnostics: NavigationDiagnostic[];
};

type AddTargetOptions = {
  additionalOrigins?: NavigationEvidence[];
  allowlistAliases?: Array<Pick<NavigationTargetAlias, 'kind' | 'target'>>;
  dedupeScope?: string;
};

export function extractNavigationEvidence(
  view: MaxNavigationMessageView,
  options: NavigationExtractionOptions = {},
): NavigationExtractionResult {
  const state: ExtractionState = {
    targets: [],
    targetByKey: new Map(),
    diagnostics: [...view.diagnostics],
  };

  if (view.direct) {
    extractContentEvidence(view.direct, state);
  }
  if (view.visibleForward) {
    extractContentEvidence(view.visibleForward, state);
  }
  for (const evidence of options.plainTextCandidates ?? []) {
    extractPlainTextCandidate(view, evidence, state);
  }

  return { targets: state.targets, diagnostics: state.diagnostics };
}

function extractContentEvidence(content: MaxNavigationContentView, state: ExtractionState): void {
  for (const markup of content.markup) {
    extractMarkupEvidence(content, markup, state);
  }
  for (const attachment of content.attachments) {
    extractAttachmentEvidence(content, attachment, state);
  }
}

function extractMarkupEvidence(
  content: MaxNavigationContentView,
  markup: MaxNavigationMarkupView,
  state: ExtractionState,
): void {
  if (markup.type === 'link') {
    const rawTarget = readString(markup.url);
    if (!rawTarget) {
      pushDiagnostic(state, content, markup.path, 'ambiguous', 'AMBIGUOUS_TARGET', markup.type);
      return;
    }
    const target = normalizeInboundHttpNavigationUrl(rawTarget);
    if (!target) {
      pushDiagnostic(
        state,
        content,
        markup.path,
        'invalid',
        'INVALID_NAVIGATION_TARGET',
        markup.type,
      );
      return;
    }
    const kind = classifyHttpTarget(target);
    addTarget(state, kind, target, evidenceForMarkup(content, markup, 'link_markup', kind, state));
    return;
  }

  if (markup.type === 'user_mention') {
    const userId = normalizeUserId(markup.userId);
    const userLink = normalizeUserLink(markup.userLink);
    const hasRawTarget = markup.userId !== undefined || markup.userLink !== undefined;
    if (!userId && !userLink) {
      pushDiagnostic(
        state,
        content,
        markup.path,
        hasRawTarget ? 'invalid' : 'ambiguous',
        hasRawTarget ? 'INVALID_NAVIGATION_TARGET' : 'AMBIGUOUS_TARGET',
        markup.type,
      );
      return;
    }
    const target = userId ? `max://user/${userId}` : (userLink as string);
    addTarget(
      state,
      'profile_mention',
      target,
      evidenceForMarkup(content, markup, 'user_mention_markup', 'profile_mention', state),
    );
    return;
  }

  if (markup.type && KNOWN_NON_NAVIGATION_MARKUP.has(markup.type)) {
    return;
  }

  const hasNavigationFields =
    markup.url !== undefined || markup.userLink !== undefined || markup.userId !== undefined;
  if (markup.type || hasNavigationFields) {
    pushDiagnostic(
      state,
      content,
      markup.path,
      markup.type ? 'unknown' : 'ambiguous',
      'UNKNOWN_MARKUP_TYPE',
      markup.type,
    );
  }
}

function extractAttachmentEvidence(
  content: MaxNavigationContentView,
  attachment: MaxNavigationAttachmentView,
  state: ExtractionState,
): void {
  if (attachment.kind === 'share') {
    if (attachment.payloadUrl === undefined || attachment.payloadUrl === null) {
      return;
    }
    const rawTarget = readString(attachment.payloadUrl);
    if (!rawTarget) {
      pushDiagnostic(
        state,
        content,
        `${attachment.path}.payload.url`,
        'ambiguous',
        'AMBIGUOUS_TARGET',
        attachment.rawType,
      );
      return;
    }
    const target = normalizeInboundHttpNavigationUrl(rawTarget);
    if (!target) {
      pushDiagnostic(
        state,
        content,
        `${attachment.path}.payload.url`,
        'invalid',
        'INVALID_NAVIGATION_TARGET',
        attachment.rawType,
      );
      return;
    }
    const kind = classifyHttpTarget(target);
    addTarget(
      state,
      kind,
      target,
      evidenceForCarrier(content, `${attachment.path}.payload.url`, 'share_attachment', kind),
    );
    return;
  }

  if (attachment.kind === 'inline_keyboard') {
    for (const button of attachment.buttons) {
      extractButtonEvidence(content, button, state);
    }
    return;
  }

  if (attachment.kind === 'unknown') {
    pushDiagnostic(
      state,
      content,
      attachment.path,
      'unknown',
      'UNKNOWN_ATTACHMENT_TYPE',
      attachment.rawType,
    );
  }
}

function extractButtonEvidence(
  content: MaxNavigationContentView,
  button: MaxNavigationButtonView,
  state: ExtractionState,
): void {
  if (button.type === 'link') {
    const rawTarget = readString(button.url);
    if (!rawTarget) {
      pushDiagnostic(state, content, button.path, 'ambiguous', 'AMBIGUOUS_TARGET', button.type);
      return;
    }
    const target = normalizeInboundHttpNavigationUrl(rawTarget);
    if (!target) {
      pushDiagnostic(
        state,
        content,
        button.path,
        'invalid',
        'INVALID_NAVIGATION_TARGET',
        button.type,
      );
      return;
    }
    const kind = classifyHttpTarget(target);
    addTarget(
      state,
      kind,
      target,
      evidenceForCarrier(content, `${button.path}.url`, 'link_button', kind),
    );
    return;
  }

  if (button.type === 'chat') {
    const chatTitle = readString(button.chatTitle);
    if (!chatTitle) {
      pushDiagnostic(
        state,
        content,
        `${button.path}.chat_title`,
        button.chatTitle === undefined || button.chatTitle === null ? 'ambiguous' : 'invalid',
        button.chatTitle === undefined || button.chatTitle === null
          ? 'AMBIGUOUS_TARGET'
          : 'INVALID_NAVIGATION_TARGET',
        button.type,
      );
      return;
    }

    const rawUuidPresent = button.uuid !== undefined && button.uuid !== null;
    const uuid = readScalar(button.uuid);
    if (rawUuidPresent && !uuid) {
      pushDiagnostic(
        state,
        content,
        `${button.path}.uuid`,
        'invalid',
        'INVALID_NAVIGATION_TARGET',
        button.type,
      );
      return;
    }

    const target = uuid ? `chat_uuid:${uuid}` : 'chat-create';
    addTarget(
      state,
      'max_entity',
      target,
      evidenceForCarrier(content, button.path, 'chat_button', 'max_entity'),
      { dedupeScope: `chat_button:${button.path}` },
    );
    return;
  }

  if (button.type === 'open_app') {
    const rawWebApp = readString(button.webApp);
    const normalizedWebApp = rawWebApp ? normalizeInboundHttpNavigationUrl(rawWebApp) : null;
    const webApp = normalizedWebApp?.startsWith('https://') ? normalizedWebApp : null;
    const webAppBot = rawWebApp && !webApp ? normalizePublicBotUsername(rawWebApp) : null;
    const webAppUrlBot = webApp ? normalizeMaxOpenAppBotUsername(webApp) : null;
    const contactId = readScalar(button.contactId);
    if (rawWebApp && !webApp && !webAppBot) {
      pushDiagnostic(
        state,
        content,
        `${button.path}.web_app`,
        'invalid',
        'INVALID_NAVIGATION_TARGET',
        button.type,
      );
    }
    if (!webApp && !webAppBot && !contactId && !rawWebApp) {
      pushDiagnostic(state, content, button.path, 'ambiguous', 'AMBIGUOUS_TARGET', button.type);
      return;
    }
    const candidates = [
      ...(webApp
        ? [
            {
              target: webApp,
              evidence: evidenceForCarrier(
                content,
                `${button.path}.web_app`,
                'open_app_button',
                'mini_app',
              ),
            },
          ]
        : []),
      ...(webAppUrlBot
        ? [
            {
              target: `bot:${webAppUrlBot}`,
              evidence: evidenceForCarrier(
                content,
                `${button.path}.web_app`,
                'open_app_button',
                'mini_app',
              ),
            },
          ]
        : []),
      ...(webAppBot
        ? [
            {
              target: `bot:${webAppBot}`,
              evidence: evidenceForCarrier(
                content,
                `${button.path}.web_app`,
                'open_app_button',
                'mini_app',
              ),
            },
          ]
        : []),
      ...(contactId
        ? [
            {
              target: `contact_id:${contactId}`,
              evidence: evidenceForCarrier(
                content,
                `${button.path}.contact_id`,
                'open_app_button',
                'mini_app',
              ),
            },
          ]
        : []),
    ];
    const primary = candidates[0];
    if (primary) {
      addTarget(state, 'mini_app', primary.target, primary.evidence, {
        additionalOrigins: candidates.slice(1).map((candidate) => candidate.evidence),
        allowlistAliases: candidates
          .slice(1)
          .map((candidate) => ({ kind: 'mini_app' as const, target: candidate.target })),
        dedupeScope: `open_app_button:${button.path}`,
      });
    }
    return;
  }

  if (button.type && KNOWN_NON_NAVIGATION_BUTTONS.has(button.type)) {
    return;
  }

  pushDiagnostic(
    state,
    content,
    button.path,
    button.type ? 'unknown' : 'ambiguous',
    'UNKNOWN_BUTTON_TYPE',
    button.type,
  );
}

function extractPlainTextCandidate(
  view: MaxNavigationMessageView,
  input: PlainTextLinkCandidate,
  state: ExtractionState,
): void {
  const content = input.provenance === 'direct' ? view.direct : view.visibleForward;
  if (!content) {
    state.diagnostics.push({
      category: 'ambiguous',
      code: 'PLAIN_TEXT_SOURCE_MISSING',
      sourcePath: input.sourcePath ?? input.provenance,
      provenance: input.provenance,
      contentFingerprint: null,
      rawType: null,
    });
    return;
  }

  const rawTarget = readString(input.target);
  if (!rawTarget) {
    pushDiagnostic(
      state,
      content,
      input.sourcePath ?? `${content.path}.text`,
      'ambiguous',
      'AMBIGUOUS_TARGET',
      null,
    );
    return;
  }

  const target = normalizeInboundHttpNavigationUrl(rawTarget);
  if (!target) {
    pushDiagnostic(
      state,
      content,
      input.sourcePath ?? `${content.path}.text`,
      'invalid',
      'INVALID_NAVIGATION_TARGET',
      null,
    );
    return;
  }

  const range = validateUtf16Range(content.text, input.from, input.length);
  if (range.status === 'invalid') {
    pushDiagnostic(
      state,
      content,
      input.sourcePath ?? `${content.path}.text`,
      'invalid',
      'INVALID_UTF16_RANGE',
      null,
    );
  }
  const kind = classifyHttpTarget(target);
  addTarget(state, kind, target, {
    kind,
    carrier: 'plain_text',
    provenance: content.provenance,
    certainty: 'text_inferred',
    enforcement: range.status === 'valid' ? 'eligible' : 'shadow_only',
    sourcePath: input.sourcePath ?? `${content.path}.text`,
    range,
    contentFingerprint: content.contentFingerprint,
  });
}

function evidenceForMarkup(
  content: MaxNavigationContentView,
  markup: MaxNavigationMarkupView,
  carrier: 'link_markup' | 'user_mention_markup',
  kind: NavigationEvidenceKind,
  state: ExtractionState,
): NavigationEvidence {
  const range = validateUtf16Range(content.text, markup.from, markup.length);
  if (range.status === 'missing') {
    pushDiagnostic(state, content, markup.path, 'ambiguous', 'MISSING_UTF16_RANGE', markup.type);
  } else if (range.status === 'invalid') {
    pushDiagnostic(state, content, markup.path, 'invalid', 'INVALID_UTF16_RANGE', markup.type);
  }
  return {
    kind,
    carrier,
    provenance: content.provenance,
    certainty: 'platform_declared',
    enforcement: range.status === 'valid' ? 'eligible' : 'shadow_only',
    sourcePath: markup.path,
    range,
    contentFingerprint: content.contentFingerprint,
  };
}

function evidenceForCarrier(
  content: MaxNavigationContentView,
  sourcePath: string,
  carrier: 'chat_button' | 'link_button' | 'open_app_button' | 'share_attachment',
  kind: NavigationEvidenceKind,
): NavigationEvidence {
  return {
    kind,
    carrier,
    provenance: content.provenance,
    certainty: 'platform_declared',
    enforcement: 'eligible',
    sourcePath,
    range: notApplicableRange(),
    contentFingerprint: content.contentFingerprint,
  };
}

function addTarget(
  state: ExtractionState,
  kind: NavigationEvidenceKind,
  target: string,
  evidence: NavigationEvidence,
  options: AddTargetOptions = {},
): void {
  const normalizedTarget = normalizeTarget(kind, target);
  const key = `${kind}\0${normalizedTarget}\0${options.dedupeScope ?? ''}`;
  const existing = state.targetByKey.get(key);
  if (existing) {
    existing.origins.push(evidence, ...(options.additionalOrigins ?? []));
    mergeAllowlistAliases(existing, options.allowlistAliases ?? []);
    if (
      evidence.enforcement === 'eligible' ||
      options.additionalOrigins?.some((origin) => origin.enforcement === 'eligible')
    ) {
      existing.enforceable = true;
    }
    return;
  }

  const origins = [evidence, ...(options.additionalOrigins ?? [])];
  const item: NavigationTargetEvidence = {
    kind,
    target,
    normalizedTarget,
    enforceable: origins.some((origin) => origin.enforcement === 'eligible'),
    origins,
  };
  mergeAllowlistAliases(item, options.allowlistAliases ?? []);
  state.targetByKey.set(key, item);
  state.targets.push(item);
}

function mergeAllowlistAliases(
  item: NavigationTargetEvidence,
  aliases: Array<Pick<NavigationTargetAlias, 'kind' | 'target'>>,
): void {
  for (const alias of aliases) {
    const normalizedTarget = normalizeTarget(alias.kind, alias.target);
    if (
      (alias.kind === item.kind && normalizedTarget === item.normalizedTarget) ||
      item.allowlistAliases?.some(
        (existing) =>
          existing.kind === alias.kind && existing.normalizedTarget === normalizedTarget,
      )
    ) {
      continue;
    }
    const normalizedAlias: NavigationTargetAlias = {
      kind: alias.kind,
      target: alias.target,
      normalizedTarget,
    };
    if (item.allowlistAliases) {
      item.allowlistAliases.push(normalizedAlias);
    } else {
      item.allowlistAliases = [normalizedAlias];
    }
  }
}

function normalizeTarget(kind: NavigationEvidenceKind, value: string): string {
  const target = value.trim();
  if (kind === 'profile_mention') {
    return target.toLowerCase();
  }
  if (/^https?:\/\//iu.test(target)) {
    try {
      return new URL(target).toString();
    } catch {
      return target;
    }
  }
  return target;
}

function normalizeInboundHttpNavigationUrl(value: string): string | null {
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > MAX_HTTP_BUTTON_URL_LENGTH ||
    INBOUND_HTTP_NAVIGATION_WHITESPACE_OR_CONTROL.test(candidate)
  ) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    const normalized = parsed.toString();
    return normalized.length <= MAX_HTTP_BUTTON_URL_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

function classifyHttpTarget(value: string): NavigationEvidenceKind {
  const parsed = new URL(value);
  return isOfficialMaxStartAppRoute(parsed) ? 'mini_app' : 'external_url';
}

function isOfficialMaxStartAppRoute(parsed: URL): boolean {
  const startAppValues = parsed.searchParams.getAll('startapp');
  return (
    parsed.protocol === 'https:' &&
    (parsed.hostname.toLowerCase() === 'max.ru' ||
      parsed.hostname.toLowerCase() === 'www.max.ru') &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.port.length === 0 &&
    parsed.hash.length === 0 &&
    startAppValues.length === 1 &&
    MAX_STARTAPP_PAYLOAD_PATTERN.test(startAppValues[0] ?? '') &&
    normalizeMaxBotPathUsername(parsed) !== null
  );
}

function normalizeMaxOpenAppBotUsername(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      (parsed.hostname.toLowerCase() !== 'max.ru' &&
        parsed.hostname.toLowerCase() !== 'www.max.ru') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    return normalizeMaxBotPathUsername(parsed);
  } catch {
    return null;
  }
}

function normalizeMaxBotPathUsername(parsed: URL): string | null {
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments.length !== 1) {
    return null;
  }
  try {
    const botId = decodeURIComponent(pathSegments[0] ?? '');
    const normalized = botId.toLowerCase();
    return MAX_BOT_PATH_ID_PATTERN.test(botId) && !RESERVED_MAX_SINGLE_SEGMENT_PATHS.has(normalized)
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function validateUtf16Range(
  text: string,
  rawFrom: unknown,
  rawLength: unknown,
): NavigationEvidenceRange {
  const hasFrom = rawFrom !== undefined && rawFrom !== null;
  const hasLength = rawLength !== undefined && rawLength !== null;
  if (!hasFrom && !hasLength) {
    return {
      status: 'missing',
      from: null,
      length: null,
      end: null,
      visibleText: null,
      invalidReason: null,
    };
  }

  const from = readInteger(rawFrom);
  const length = readInteger(rawLength);
  if (from === null || length === null) {
    return invalidRange(from, length, null, 'non_integer');
  }
  const end = from + length;
  if (length <= 0) {
    return invalidRange(from, length, end, 'non_positive_length');
  }
  if (from < 0 || end > text.length || end <= from) {
    return invalidRange(from, length, end, 'out_of_bounds');
  }
  if (!isUtf16Boundary(text, from) || !isUtf16Boundary(text, end)) {
    return invalidRange(from, length, end, 'splits_surrogate_pair');
  }

  return {
    status: 'valid',
    from,
    length,
    end,
    visibleText: text.slice(from, end),
    invalidReason: null,
  };
}

function isUtf16Boundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return true;
  }
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function invalidRange(
  from: number | null,
  length: number | null,
  end: number | null,
  invalidReason: NonNullable<NavigationEvidenceRange['invalidReason']>,
): NavigationEvidenceRange {
  return {
    status: 'invalid',
    from,
    length,
    end,
    visibleText: null,
    invalidReason,
  };
}

function notApplicableRange(): NavigationEvidenceRange {
  return {
    status: 'not_applicable',
    from: null,
    length: null,
    end: null,
    visibleText: null,
    invalidReason: null,
  };
}

function pushDiagnostic(
  state: ExtractionState,
  content: MaxNavigationContentView,
  sourcePath: string,
  category: NavigationDiagnostic['category'],
  code: NavigationDiagnostic['code'],
  rawType: string | null,
): void {
  state.diagnostics.push({
    category,
    code,
    sourcePath,
    provenance: content.provenance,
    contentFingerprint: content.contentFingerprint,
    rawType,
  });
}

function readInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readScalar(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
}

function normalizeUserId(value: unknown): string | null {
  const candidate = readScalar(value);
  return candidate && /^[1-9]\d{0,19}$/u.test(candidate) ? candidate : null;
}

function normalizeUserLink(value: unknown): string | null {
  const candidate = readString(value);
  if (!candidate) {
    return null;
  }
  const userPath = candidate.match(/^user\/([1-9]\d{0,19})$/u);
  if (userPath) {
    return `max://user/${userPath[1]}`;
  }
  return /^@[a-z0-9_][a-z0-9_.-]{0,63}$/iu.test(candidate) ? candidate : null;
}

function normalizePublicBotUsername(value: string): string | null {
  const candidate = value.trim().replace(/^@/u, '');
  const normalized = candidate.toLowerCase();
  return /^[A-Za-z][A-Za-z0-9_]{1,63}$/u.test(candidate) &&
    !RESERVED_MAX_SINGLE_SEGMENT_PATHS.has(normalized)
    ? normalized
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
