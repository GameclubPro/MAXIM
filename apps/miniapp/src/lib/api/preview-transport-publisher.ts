import {
  decodePublisherEntitiesCursor,
  encodePublisherEntitiesCursor,
  MAX_PUBLISHER_BULK_REFRESH_TARGETS,
  managedEntityPublicationPolicySchema,
  PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesRefreshResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  publisherEntityModuleSettingsSchema,
  publisherEntityRefreshResponseSchema,
  publisherPostImportCreateRequestSchema,
  publisherPostImportCurrentResponseSchema,
  publisherPostImportSessionSchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  updatePublisherEntityModuleSettingsRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherChatCommentSettings,
  type PublisherEntity,
} from '@maxim/contracts/publisher';
import {
  archivePublisherAutoReplyRequestSchema,
  archivePublisherAutoReplyResponseSchema,
  createPublisherAutoReplyAuthoringSessionRequestSchema,
  createPublisherAutoReplyRequestSchema,
  createPublisherAutoReplyV2RequestSchema,
  normalizePublisherAutoReplyPhrase,
  publisherAutoReplyAuthoringSessionCurrentResponseSchema,
  publisherAutoReplyAuthoringSessionResponseSchema,
  publisherAutoReplyListResponseSchema,
  publisherAutoReplyListResponseV2Schema,
  publisherAutoReplyPreviewRequestSchema,
  publisherAutoReplyPreviewResponseSchema,
  publisherAutoReplyRuleSchema,
  publisherAutoReplyRuleV2Schema,
  updatePublisherAutoReplyRequestSchema,
  updatePublisherAutoReplyV2RequestSchema,
  type PublisherAutoReplyAuthoringSession,
  type PublisherAutoReplyContentInput,
  type PublisherAutoReplyMatchKind,
  type PublisherAutoReplyPreviewResponse,
  type PublisherAutoReplyRule,
  type PublisherAutoReplyRuleV2,
} from '@maxim/contracts/publisher-auto-replies';
import { PREVIEW_CHAT_ID } from '../design-preview';
import { ApiRequestError } from '../api-request-error';
import { PREVIEW_NOT_HANDLED, type PreviewRequestHandler } from './preview-transport-runtime';
import { parseJsonBody } from './preview-transport-shared';
import type { PreviewState } from './preview-transport-state';

function getPreviewPublisherPolicies(
  state: PreviewState,
): Record<string, ManagedEntityPublicationPolicy> {
  const extended = state as PreviewState & {
    publisherPolicies?: Record<string, ManagedEntityPublicationPolicy>;
  };
  extended.publisherPolicies ??= {};
  return extended.publisherPolicies;
}

function getPreviewPublisherRefreshes(state: PreviewState): Record<string, string> {
  const extended = state as PreviewState & {
    publisherRefreshes?: Record<string, string>;
  };
  extended.publisherRefreshes ??= {};
  return extended.publisherRefreshes;
}

function getPreviewPublisherChatComments(
  state: PreviewState,
): Record<string, PublisherChatCommentSettings> {
  const extended = state as PreviewState & {
    publisherChatComments?: Record<string, PublisherChatCommentSettings>;
  };
  extended.publisherChatComments ??= {};
  return extended.publisherChatComments;
}

function getPreviewPublisherModuleRevisions(state: PreviewState): Record<string, number> {
  const extended = state as PreviewState & { publisherModuleRevisions?: Record<string, number> };
  extended.publisherModuleRevisions ??= {};
  return extended.publisherModuleRevisions;
}

function getPreviewPublisherChannelSuggestions(state: PreviewState): Record<string, boolean> {
  const extended = state as PreviewState & {
    publisherChannelSuggestions?: Record<string, boolean>;
  };
  extended.publisherChannelSuggestions ??= {};
  return extended.publisherChannelSuggestions;
}

function getPreviewPublisherChannelComments(state: PreviewState): Record<string, boolean> {
  const extended = state as PreviewState & {
    publisherChannelComments?: Record<string, boolean>;
  };
  extended.publisherChannelComments ??= {};
  return extended.publisherChannelComments;
}

function getPreviewPublisherAutoRepliesEnabled(state: PreviewState): Record<string, boolean> {
  const extended = state as PreviewState & {
    publisherAutoRepliesEnabled?: Record<string, boolean>;
  };
  extended.publisherAutoRepliesEnabled ??= {};
  return extended.publisherAutoRepliesEnabled;
}

function getPreviewPublisherAutoReplies(
  state: PreviewState,
): Record<string, PreviewPublisherAutoReplyStoredRule[]> {
  const extended = state as PreviewState & {
    publisherAutoReplies?: Record<string, PreviewPublisherAutoReplyStoredRule[]>;
  };
  extended.publisherAutoReplies ??= {};
  return extended.publisherAutoReplies;
}

type PreviewPublisherAutoReplyStoredRule = PublisherAutoReplyRule & {
  phrases: string[];
  matchInContext: boolean;
  fuzzyMatch: boolean;
};

const PUBLISHER_AUTO_REPLY_VERSION_CONFLICT_CODE = 'PUBLISHER_AUTO_REPLY_VERSION_CONFLICT';
const PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT_CODE = 'PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT';
const PUBLISHER_AUTO_REPLY_CLIENT_UPGRADE_REQUIRED_CODE =
  'PUBLISHER_AUTO_REPLY_CLIENT_UPGRADE_REQUIRED';

function getPreviewPublisherAutoReplyAuthoring(
  state: PreviewState,
): Record<string, PublisherAutoReplyAuthoringSession | null> {
  const extended = state as PreviewState & {
    publisherAutoReplyAuthoring?: Record<string, PublisherAutoReplyAuthoringSession | null>;
  };
  extended.publisherAutoReplyAuthoring ??= {};
  return extended.publisherAutoReplyAuthoring;
}

function buildPreviewAutoReplyAssetBlob(): Blob {
  const binary = globalThis.atob(
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwAgMAAAAqbBEUAAAADFBMVEXC6f6k0/Oz3/iTx+5Xsu0OAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABbElEQVQoz2NgYGB6wAABsgxIIAxMMs0AU7PAJH8ImDIHk3t0gASvgzzDBKCqgyJAjtiOKwxXGBhYhTIYChjMt+cxbGBg0PsiwOjCILv1GEiLMU8AUwgD49VckFmPeQ4wRDAwsM8DcnYeuuwAUsB+HUg8buAGWyDqxMDAuFZFBcyxBcpz51qYgDnqQA4ne9IVhGN/p6vA2YzuoRIMDAkQDr9f0wYGJg8IR7/h9AEGpgCojJY3kFSAcPTWNiAMY70H9BGMY+sBZa8A4h1QQfZwB4Rys1UTwCEFVheUsQUiytvAwHRAKx3C4WRgYL4mwgnhAJWJNzBog5gcIOJyU/MNBj2o2xvjby1n2M3AwAVSeG3p0nugSNkKcrJ6bdQUkGAQOAxkF4LEuFWlwMbXgkhuhygkPzClIXEkvBEcZj9giC+AcpiuTUFwGEQTGJi7kJIAUwZyggD5khFZgBWhEOxFBmQ+wlSQthQIrcDAAADorEXVKBtnwAAAAABJRU5ErkJggg==',
  );
  return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
    type: 'image/png',
  });
}

function listPreviewPublisherAutoReplies(
  state: PreviewState,
  chatId: string,
): PreviewPublisherAutoReplyStoredRule[] {
  const store = getPreviewPublisherAutoReplies(state);
  if (!store[chatId]) {
    const legacyRule = publisherAutoReplyRuleSchema.parse({
      id: `preview-auto-reply-${chatId}-1`,
      chatId,
      phrase: 'Прайс',
      enabled: true,
      cooldownSeconds: 30,
      version: 1,
      currentContentRevisionId: `preview-auto-reply-content-${chatId}-1`,
      content: {
        id: `preview-auto-reply-content-${chatId}-1`,
        revision: 1,
        text: '**Актуальный прайс** уже готов. Напишите администратору, если нужна помощь.',
        textFormat: 'markdown',
        images: [
          {
            id: `preview-auto-reply-asset-${chatId}-1`,
            mimeType: 'image/png',
            fileName: 'price.png',
            sizeBytes: 68,
            previewUrl: `/publisher/entities/chat/${encodeURIComponent(chatId)}/auto-replies/preview-auto-reply-${encodeURIComponent(chatId)}-1/assets/preview-auto-reply-asset-${encodeURIComponent(chatId)}-1`,
          },
        ],
        buttons: [
          {
            text: 'Открыть прайс',
            url: 'https://max.ru/publik_preview_bot',
            row: 0,
          },
        ],
        createdAt: state.clock.now().toISOString(),
      },
      createdByUserId: 'preview-user',
      updatedByUserId: 'preview-user',
      createdAt: state.clock.now().toISOString(),
      updatedAt: state.clock.now().toISOString(),
      archivedAt: null,
    });
    store[chatId] = [
      {
        ...legacyRule,
        phrases: ['Прайс', 'Стоимость'],
        matchInContext: true,
        fuzzyMatch: false,
      },
    ];
  }
  return store[chatId];
}

function presentPreviewPublisherAutoReplyV1(
  rule: PreviewPublisherAutoReplyStoredRule,
): PublisherAutoReplyRule {
  return publisherAutoReplyRuleSchema.parse({
    id: rule.id,
    chatId: rule.chatId,
    phrase: rule.phrases[0] ?? rule.phrase,
    enabled: rule.enabled,
    cooldownSeconds: rule.cooldownSeconds,
    version: rule.version,
    currentContentRevisionId: rule.currentContentRevisionId,
    content: rule.content,
    createdByUserId: rule.createdByUserId,
    updatedByUserId: rule.updatedByUserId,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    archivedAt: rule.archivedAt,
  });
}

function presentPreviewPublisherAutoReplyV2(
  rule: PreviewPublisherAutoReplyStoredRule,
): PublisherAutoReplyRuleV2 {
  return publisherAutoReplyRuleV2Schema.parse({
    id: rule.id,
    chatId: rule.chatId,
    phrases: rule.phrases,
    matchInContext: rule.matchInContext,
    fuzzyMatch: rule.fuzzyMatch,
    enabled: rule.enabled,
    cooldownSeconds: rule.cooldownSeconds,
    version: rule.version,
    currentContentRevisionId: rule.currentContentRevisionId,
    content: rule.content,
    createdByUserId: rule.createdByUserId,
    updatedByUserId: rule.updatedByUserId,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    archivedAt: rule.archivedAt,
  });
}

function buildPreviewPublisherEntity(
  state: PreviewState,
  entityType: ManagedEntityType,
  entityId: string,
): PublisherEntity | null {
  const source = (entityType === 'channel' ? state.channels : state.chats).find(
    (item) => item.id === entityId,
  );
  if (!source) {
    return null;
  }
  const policy =
    getPreviewPublisherPolicies(state)[`${entityType}:${entityId}`] ??
    managedEntityPublicationPolicySchema.parse({
      publikEnabled: state.publisherPolicyVariant !== 'permission',
      revision: 0,
      updatedAt: null,
    });
  const entityKey = `${entityType}:${entityId}`;
  const refreshedAt = getPreviewPublisherRefreshes(state)[entityKey] ?? null;
  const checkedAt = refreshedAt ?? state.clock.now().toISOString();
  const setupBlocker =
    !refreshedAt && state.publisherPolicyVariant === 'setup' && entityId === PREVIEW_CHAT_ID
      ? 'bot_not_admin'
      : !refreshedAt && entityId === 'preview-chat-2'
        ? 'write_permission_missing'
        : null;
  const runtimeUnavailable = entityId === 'preview-channel-2';
  const channelSuggestionsEnabled =
    entityType === 'channel' && (getPreviewPublisherChannelSuggestions(state)[entityId] ?? false);
  const channelCommentsEnabled =
    entityType === 'channel' &&
    (getPreviewPublisherChannelComments(state)[entityId] ?? state.channelSettings.commentsEnabled);
  const readiness = !policy.publikEnabled
    ? {
        state: 'disabled' as const,
        canPublish: false,
        canUseChatComments: false,
        canUseChannelComments: false,
        canPublishSuggestions: false,
        blockerCode: 'policy_disabled' as const,
        checkedAt,
        retryAt: null,
      }
    : setupBlocker
      ? {
          state: 'setup_required' as const,
          canPublish: false,
          canUseChatComments: false,
          canUseChannelComments: false,
          canPublishSuggestions: false,
          blockerCode: setupBlocker,
          checkedAt: null,
          retryAt: null,
        }
      : runtimeUnavailable
        ? {
            state: 'temporarily_unavailable' as const,
            canPublish: false,
            canUseChatComments: false,
            canUseChannelComments: false,
            canPublishSuggestions: false,
            blockerCode: 'publisher_runtime_unavailable' as const,
            checkedAt,
            retryAt: null,
          }
        : {
            state: 'ready' as const,
            canPublish: true,
            canUseChatComments:
              entityType === 'chat' &&
              getPreviewPublisherChatComments(state)[entityId]?.commentsEnabled === true,
            canUseChannelComments: channelCommentsEnabled,
            canPublishSuggestions: channelSuggestionsEnabled,
            blockerCode: null,
            checkedAt,
            retryAt: null,
          };
  return publisherEntitySchema.parse({
    id: source.id,
    title: source.title,
    entityType,
    avatarUrl: source.avatarUrl ?? null,
    entityUrl: `https://max.ru/join/${encodeURIComponent(source.id)}`,
    policy,
    channelPostSignature: entityType === 'channel' ? state.channelPostSignature : null,
    moduleSettings: {
      revision: getPreviewPublisherModuleRevisions(state)[entityKey] ?? 0,
      chatComments:
        entityType === 'chat'
          ? (getPreviewPublisherChatComments(state)[entityId] ?? {
              commentsEnabled: false,
              commentsAdminsEnabled: false,
              commentsChatBroadcastsEnabled: false,
            })
          : null,
      autoRepliesEnabled:
        entityType === 'chat'
          ? (getPreviewPublisherAutoRepliesEnabled(state)[entityId] ?? true)
          : null,
      channelCommentsEnabled: entityType === 'channel' ? channelCommentsEnabled : null,
      channelSuggestionsEnabled: entityType === 'channel' ? channelSuggestionsEnabled : null,
    },
    readiness,
  });
}

function listPreviewPublisherEntities(state: PreviewState): PublisherEntity[] {
  const baseItems = [
    ...state.chats.map((item) => buildPreviewPublisherEntity(state, 'chat', item.id)),
    ...state.channels.map((item) => buildPreviewPublisherEntity(state, 'channel', item.id)),
  ].filter((item): item is PublisherEntity => item !== null);
  if (state.publisherEntitiesVariant === 'empty') {
    return [];
  }
  if (state.publisherEntitiesVariant === 'channel-only') {
    return baseItems.filter((item) => item.entityType === 'channel');
  }
  if (state.publisherEntitiesVariant !== 'large') {
    return baseItems;
  }
  return Array.from({ length: 400 }, (_, index) => {
    const source = baseItems[index % baseItems.length]!;
    return {
      ...source,
      id: `${source.id}-large-${String(index + 1).padStart(3, '0')}`,
      title: `${source.title} ${index + 1}`,
    };
  });
}

function summarizePreviewPublisherEntities(entities: readonly PublisherEntity[]) {
  const chat = entities.filter((entity) => entity.entityType === 'chat').length;
  const ready = entities.filter((entity) => entity.readiness.canPublish).length;
  return {
    total: entities.length,
    chat,
    channel: entities.length - chat,
    ready,
    attention: entities.length - ready,
  };
}

function listPreviewPublisherEntitiesPage(state: PreviewState, url: URL) {
  const query = publisherEntitiesCursorQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const entities = listPreviewPublisherEntities(state);
  const normalizedQuery = query.query.toLocaleLowerCase('ru-RU');
  const filtered = entities.filter(
    (entity) =>
      (!query.entityType || entity.entityType === query.entityType) &&
      (!query.readiness ||
        (query.readiness === 'ready'
          ? entity.readiness.canPublish
          : !entity.readiness.canPublish)) &&
      (!normalizedQuery ||
        `${entity.title} ${entity.id}`.toLocaleLowerCase('ru-RU').includes(normalizedQuery)),
  );
  const cursor = query.cursor ? decodePublisherEntitiesCursor(query.cursor) : null;
  if (
    query.cursor &&
    (!cursor ||
      cursor.query !== query.query ||
      cursor.entityType !== (query.entityType ?? null) ||
      cursor.readiness !== (query.readiness ?? null))
  ) {
    throw new ApiRequestError(
      400,
      JSON.stringify({ code: PUBLISHER_ENTITIES_CURSOR_INVALID_CODE }),
      'Invalid publisher entities cursor',
    );
  }
  const startIndex = cursor?.offset ?? 0;
  if (cursor && startIndex >= filtered.length) {
    throw new ApiRequestError(
      400,
      JSON.stringify({ code: PUBLISHER_ENTITIES_CURSOR_INVALID_CODE }),
      'Invalid publisher entities cursor',
    );
  }
  const items = filtered.slice(startIndex, startIndex + query.limit);
  const hasMore = startIndex + items.length < filtered.length;
  const last = items.at(-1);

  return publisherEntitiesCursorResponseSchema.parse({
    items,
    nextCursor:
      hasMore && last
        ? encodePublisherEntitiesCursor({
            v: 1,
            snapshotId: cursor?.snapshotId ?? 'preview_snapshot',
            offset: startIndex + items.length,
            query: query.query,
            entityType: query.entityType ?? null,
            readiness: query.readiness ?? null,
          })
        : null,
    filteredTotal: filtered.length,
    summary: summarizePreviewPublisherEntities(entities),
  });
}

function buildPreviewPublisherAutoReplyContent(
  state: PreviewState,
  chatId: string,
  ruleId: string,
  revision: number,
  input: PublisherAutoReplyContentInput,
  previous: PublisherAutoReplyRule['content'] | null,
): PublisherAutoReplyRule['content'] {
  const previousAssets = new Map(previous?.images.map((asset) => [asset.id, asset]) ?? []);
  const images = input.images.map((image, index) => {
    if (image.type === 'image-ref') {
      const retained = previousAssets.get(image.assetId);
      if (!retained) {
        throw new ApiRequestError(400, '', 'Preview auto-reply asset not found');
      }
      return retained;
    }
    const id = `preview-auto-reply-asset-${ruleId}-${revision}-${index + 1}`;
    return {
      id,
      mimeType: image.mimeType,
      fileName: image.fileName,
      sizeBytes: Math.max(1, Math.floor((image.base64.length * 3) / 4)),
      previewUrl: `/publisher/entities/chat/${encodeURIComponent(chatId)}/auto-replies/${encodeURIComponent(ruleId)}/assets/${encodeURIComponent(id)}`,
    };
  });
  return {
    id: `preview-auto-reply-content-${ruleId}-${revision}`,
    revision,
    text: input.text,
    textFormat: input.textFormat,
    images,
    buttons: input.buttons,
    createdAt: state.clock.now().toISOString(),
  };
}

function publisherAutoReplyConflict(code: string, message: string): ApiRequestError {
  return new ApiRequestError(409, JSON.stringify({ statusCode: 409, code }), message);
}

function assertPreviewPublisherAutoReplyFuzzyPhrases(
  phrases: readonly string[],
  fuzzyMatch: boolean,
): void {
  if (!fuzzyMatch) return;
  const invalid = phrases.some((phrase) => {
    const characters = normalizePublisherAutoReplyPhrase(phrase).match(/[\p{L}\p{M}\p{N}]/gu);
    return (characters?.length ?? 0) < 5;
  });
  if (!invalid) return;
  const code = 'PUBLISHER_AUTO_REPLY_FUZZY_PHRASE_TOO_SHORT';
  throw new ApiRequestError(
    400,
    JSON.stringify({ statusCode: 400, code }),
    'Для учёта опечаток каждая фраза должна содержать не меньше 5 символов.',
  );
}

function assertPreviewPublisherAutoReplyPhrasesAvailable(
  rules: readonly PreviewPublisherAutoReplyStoredRule[],
  phrases: readonly string[],
  excludeRuleId?: string,
): void {
  const occupied = new Set(
    rules
      .filter((rule) => rule.id !== excludeRuleId)
      .flatMap((rule) => rule.phrases.map(normalizePublisherAutoReplyPhrase)),
  );
  if (phrases.some((phrase) => occupied.has(normalizePublisherAutoReplyPhrase(phrase)))) {
    throw publisherAutoReplyConflict(
      PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT_CODE,
      'Preview auto-reply phrase conflict',
    );
  }
}

function replacePreviewPublisherAutoReplyPrimaryPhrase(
  current: readonly string[],
  phrase: string,
): string[] {
  const normalized = normalizePublisherAutoReplyPhrase(phrase);
  return [
    phrase,
    ...current.slice(1).filter((item) => normalizePublisherAutoReplyPhrase(item) !== normalized),
  ];
}

function resolvePreviewLegacyPhraseUpdate(
  current: PreviewPublisherAutoReplyStoredRule,
  phrase: string | undefined,
): string[] | undefined {
  if (phrase === undefined) {
    return undefined;
  }
  const extended = current.matchInContext || current.fuzzyMatch || current.phrases.length > 1;
  if (!extended) {
    return replacePreviewPublisherAutoReplyPrimaryPhrase(current.phrases, phrase);
  }
  if (
    normalizePublisherAutoReplyPhrase(phrase) !== normalizePublisherAutoReplyPhrase(current.phrase)
  ) {
    throw publisherAutoReplyConflict(
      PUBLISHER_AUTO_REPLY_CLIENT_UPGRADE_REQUIRED_CODE,
      'Preview auto-reply client upgrade required',
    );
  }
  return undefined;
}

const PREVIEW_AUTO_REPLY_TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const PREVIEW_AUTO_REPLY_MATCH_LIMITS = Object.freeze({
  messageCodePoints: 4_096,
  messageTokens: 256,
  candidates: 200,
  fuzzyCandidates: 50,
});

type PreviewAutoReplyMatchCandidate = {
  ruleKey: string;
  ruleId: string | null;
  position: number;
  phrase: string;
  matchInContext: boolean;
  fuzzyMatch: boolean;
  matchedDraft: boolean;
};

type PreviewAutoReplyScoredMatch = {
  ruleKey: string;
  position: number;
  rank: number;
  tokenCount: number;
  phraseLength: number;
  selected: NonNullable<PublisherAutoReplyPreviewResponse['selected']>;
};

const PREVIEW_AUTO_REPLY_MATCH_RANK: Record<PublisherAutoReplyMatchKind, number> = {
  exact_full: 4,
  exact_context: 3,
  fuzzy_full: 2,
  fuzzy_context: 1,
};

function buildPreviewPublisherAutoReplyMatch(
  rules: readonly PreviewPublisherAutoReplyStoredRule[],
  request: ReturnType<typeof publisherAutoReplyPreviewRequestSchema.parse>,
): PublisherAutoReplyPreviewResponse {
  const candidates: PreviewAutoReplyMatchCandidate[] = rules
    .filter((rule) => rule.enabled && rule.id !== request.draft?.ruleId)
    .flatMap((rule) =>
      rule.phrases.map((phrase, position) => ({
        ruleKey: rule.id,
        ruleId: rule.id,
        position,
        phrase,
        matchInContext: rule.matchInContext,
        fuzzyMatch: rule.fuzzyMatch,
        matchedDraft: false,
      })),
    );
  if (request.draft?.enabled) {
    const draftRuleId = request.draft.ruleId ?? null;
    candidates.push(
      ...request.draft.phrases.map((phrase, position) => ({
        ruleKey: `draft:${draftRuleId ?? 'new'}`,
        ruleId: null,
        position,
        phrase,
        matchInContext: request.draft!.matchInContext,
        fuzzyMatch: request.draft!.fuzzyMatch,
        matchedDraft: true,
      })),
    );
  }

  const normalizedMessage = normalizePublisherAutoReplyPhrase(request.message);
  const messageTokens = previewAutoReplyTokens(normalizedMessage);
  if (
    Array.from(request.message).length > PREVIEW_AUTO_REPLY_MATCH_LIMITS.messageCodePoints ||
    Array.from(normalizedMessage).length > PREVIEW_AUTO_REPLY_MATCH_LIMITS.messageCodePoints ||
    messageTokens.length > PREVIEW_AUTO_REPLY_MATCH_LIMITS.messageTokens
  ) {
    return publisherAutoReplyPreviewResponseSchema.parse({ outcome: 'no_match', selected: null });
  }
  if (candidates.length > PREVIEW_AUTO_REPLY_MATCH_LIMITS.candidates) {
    return resolvePreviewPublisherAutoReplyMatches(
      candidates
        .filter(
          (candidate) => normalizePublisherAutoReplyPhrase(candidate.phrase) === normalizedMessage,
        )
        .map((candidate) =>
          previewAutoReplyScoredMatch(
            candidate,
            previewAutoReplyTokens(normalizedMessage),
            'exact_full',
            0,
          ),
        ),
    );
  }
  const exactMatches = candidates.flatMap((candidate) => {
    const normalizedPhrase = normalizePublisherAutoReplyPhrase(candidate.phrase);
    const phraseTokens = previewAutoReplyTokens(normalizedPhrase);
    if (normalizedMessage === normalizedPhrase) {
      return [previewAutoReplyScoredMatch(candidate, phraseTokens, 'exact_full', 0)];
    }
    if (candidate.matchInContext && previewAutoReplyContainsTokens(messageTokens, phraseTokens)) {
      return [previewAutoReplyScoredMatch(candidate, phraseTokens, 'exact_context', 0)];
    }
    return [];
  });
  if (exactMatches.length === 0) {
    const fuzzyCandidateCount = candidates.filter((candidate) => candidate.fuzzyMatch).length;
    if (fuzzyCandidateCount > PREVIEW_AUTO_REPLY_MATCH_LIMITS.fuzzyCandidates) {
      return publisherAutoReplyPreviewResponseSchema.parse({ outcome: 'no_match', selected: null });
    }
  }
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : candidates.flatMap((candidate) => previewAutoReplyFuzzyMatch(candidate, messageTokens));
  return resolvePreviewPublisherAutoReplyMatches(matches);
}

function previewAutoReplyFuzzyMatch(
  candidate: PreviewAutoReplyMatchCandidate,
  messageTokens: readonly string[],
): PreviewAutoReplyScoredMatch[] {
  if (!candidate.fuzzyMatch) return [];
  const phraseTokens = previewAutoReplyTokens(normalizePublisherAutoReplyPhrase(candidate.phrase));
  const limit = previewAutoReplyFuzzyLimit(phraseTokens);
  if (limit === null || phraseTokens.length === 0) return [];
  const fuzzyPhrase = phraseTokens.map(previewAutoReplyFuzzyText).join(' ');
  const fuzzyMessageTokens = messageTokens.map(previewAutoReplyFuzzyText);
  if (fuzzyMessageTokens.length === phraseTokens.length) {
    const distance = previewAutoReplyOsaDistance(fuzzyMessageTokens.join(' '), fuzzyPhrase, limit);
    return distance <= limit
      ? [previewAutoReplyScoredMatch(candidate, phraseTokens, 'fuzzy_full', distance)]
      : [];
  }
  if (!candidate.matchInContext || fuzzyMessageTokens.length < phraseTokens.length) return [];
  let best = limit + 1;
  for (let start = 0; start <= fuzzyMessageTokens.length - phraseTokens.length; start += 1) {
    best = Math.min(
      best,
      previewAutoReplyOsaDistance(
        fuzzyMessageTokens.slice(start, start + phraseTokens.length).join(' '),
        fuzzyPhrase,
        limit,
      ),
    );
  }
  return best <= limit
    ? [previewAutoReplyScoredMatch(candidate, phraseTokens, 'fuzzy_context', best)]
    : [];
}

function previewAutoReplyScoredMatch(
  candidate: PreviewAutoReplyMatchCandidate,
  phraseTokens: readonly string[],
  matchKind: PublisherAutoReplyMatchKind,
  distance: number,
): PreviewAutoReplyScoredMatch {
  return {
    ruleKey: candidate.ruleKey,
    position: candidate.position,
    rank: PREVIEW_AUTO_REPLY_MATCH_RANK[matchKind],
    tokenCount: phraseTokens.length,
    phraseLength: Array.from(phraseTokens.join('')).length,
    selected: {
      ruleId: candidate.ruleId,
      phrase: candidate.phrase,
      matchKind,
      distance,
      matchedDraft: candidate.matchedDraft,
    },
  };
}

function resolvePreviewPublisherAutoReplyMatches(
  matches: readonly PreviewAutoReplyScoredMatch[],
): PublisherAutoReplyPreviewResponse {
  if (matches.length === 0) {
    return publisherAutoReplyPreviewResponseSchema.parse({ outcome: 'no_match', selected: null });
  }
  const bestByRule = new Map<string, PreviewAutoReplyScoredMatch>();
  for (const match of matches) {
    const current = bestByRule.get(match.ruleKey);
    const quality = current ? comparePreviewAutoReplyMatch(match, current) : 1;
    if (quality > 0 || (quality === 0 && match.position < current!.position)) {
      bestByRule.set(match.ruleKey, match);
    }
  }
  const ruleMatches = [...bestByRule.values()];
  let best = ruleMatches[0]!;
  for (const match of ruleMatches.slice(1)) {
    if (comparePreviewAutoReplyMatch(match, best) > 0) best = match;
  }
  const tied = ruleMatches.filter((match) => comparePreviewAutoReplyMatch(match, best) === 0);
  return tied.length === 1
    ? publisherAutoReplyPreviewResponseSchema.parse({ outcome: 'matched', selected: best.selected })
    : publisherAutoReplyPreviewResponseSchema.parse({ outcome: 'ambiguous', selected: null });
}

function comparePreviewAutoReplyMatch(
  left: PreviewAutoReplyScoredMatch,
  right: PreviewAutoReplyScoredMatch,
): number {
  return (
    left.rank - right.rank ||
    right.selected.distance - left.selected.distance ||
    left.tokenCount - right.tokenCount ||
    left.phraseLength - right.phraseLength
  );
}

function previewAutoReplyTokens(value: string): string[] {
  return value.match(PREVIEW_AUTO_REPLY_TOKEN_PATTERN) ?? [];
}

function previewAutoReplyContainsTokens(
  messageTokens: readonly string[],
  phraseTokens: readonly string[],
): boolean {
  if (phraseTokens.length === 0 || phraseTokens.length > messageTokens.length) return false;
  for (let start = 0; start <= messageTokens.length - phraseTokens.length; start += 1) {
    if (phraseTokens.every((token, offset) => token === messageTokens[start + offset])) return true;
  }
  return false;
}

function previewAutoReplyFuzzyText(value: string): string {
  return value.replace(/ё/gu, 'е');
}

function previewAutoReplyFuzzyLimit(tokens: readonly string[]): number | null {
  const length = Array.from(tokens.join('')).length;
  if (length < 5) return null;
  if (length <= 9) return 1;
  if (length <= 19) return 2;
  return 3;
}

function previewAutoReplyOsaDistance(leftValue: string, rightValue: string, limit: number): number {
  if (leftValue === rightValue) return 0;
  const left = Array.from(leftValue);
  const right = Array.from(rightValue);
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previousPrevious: number[] | null = null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = Array<number>(right.length + 1).fill(limit + 1);
    current[0] = leftIndex;
    const start = Math.max(1, leftIndex - limit);
    const end = Math.min(right.length, leftIndex + limit);
    for (let rightIndex = start; rightIndex <= end; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      if (
        previousPrevious &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        current[rightIndex] = Math.min(current[rightIndex]!, previousPrevious[rightIndex - 2]! + 1);
      }
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length]! <= limit ? previous[right.length]! : limit + 1;
}

export const handlePublisherPreviewRequest: PreviewRequestHandler = ({
  state,
  url,
  segments,
  method,
  init,
}) => {
  if (url.pathname === '/publisher/post-imports' && method === 'POST') {
    publisherPostImportCreateRequestSchema.parse(parseJsonBody(init));
    const session = publisherPostImportSessionSchema.parse({
      id: 'preview-import-session-123456',
      status: 'waiting',
      expiresAt: new Date(state.clock.now().getTime() + 10 * 60_000).toISOString(),
      publicationId: null,
      botUrl: 'https://max.ru/se14088825_bot?start=pi_preview_import_token_123456',
      failureCode: null,
      omissions: [],
    });
    state.publisherPostImportSession = session;
    return session;
  }
  if (
    (url.pathname === '/publisher/post-imports/active' ||
      url.pathname === '/publisher/post-imports') &&
    method === 'GET'
  ) {
    return publisherPostImportCurrentResponseSchema.parse({
      session: state.publisherPostImportSession,
    });
  }
  if (
    segments[0] === 'publisher' &&
    segments[1] === 'post-imports' &&
    segments[2] === 'by-token' &&
    segments[3] &&
    segments.length === 4 &&
    method === 'GET'
  ) {
    return publisherPostImportCurrentResponseSchema.parse({
      session:
        decodeURIComponent(segments[3]) === 'preview_import_token_123456'
          ? state.publisherPostImportSession
          : null,
    });
  }
  if (url.pathname === '/publisher/post-imports' && method === 'DELETE') {
    if (!state.publisherPostImportSession) {
      throw new ApiRequestError(404, '', 'Preview publisher import not found');
    }
    const session = publisherPostImportSessionSchema.parse({
      ...state.publisherPostImportSession,
      status: 'canceled',
      publicationId: null,
      botUrl: null,
      failureCode: null,
    });
    state.publisherPostImportSession = null;
    return session;
  }
  if (
    segments[0] === 'publisher' &&
    segments[1] === 'post-imports' &&
    segments[2] &&
    segments[3] === 'assets' &&
    segments[4] &&
    segments.length === 5 &&
    method === 'GET'
  ) {
    const session = state.publisherPostImportSession;
    const publication = session?.publicationId
      ? state.publications.find((item) => item.id === session.publicationId)
      : null;
    const assetId = decodeURIComponent(segments[4]);
    if (
      !session ||
      session.status !== 'ready' ||
      session.id !== decodeURIComponent(segments[2]) ||
      !publication?.content.media.some((asset) => asset.id === assetId && asset.type === 'image')
    ) {
      throw new ApiRequestError(404, '', 'Preview publisher import asset not found');
    }
    const binary = globalThis.atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    );
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
      type: 'image/png',
    });
  }
  if (url.pathname === '/publisher/entities' && method === 'GET') {
    if (state.publisherEntitiesVariant === 'error') {
      throw new ApiRequestError(503, '', 'Preview publisher entities unavailable');
    }
    return url.searchParams.get('pagination') === 'cursor'
      ? listPreviewPublisherEntitiesPage(state, url)
      : publisherEntitiesResponseSchema.parse({
          items: listPreviewPublisherEntities(state),
        });
  }
  if (url.pathname === '/publisher/entities/refresh' && method === 'POST') {
    const entities = listPreviewPublisherEntities(state).slice(
      0,
      MAX_PUBLISHER_BULK_REFRESH_TARGETS,
    );
    const refreshedAt = new Date(state.clock.now().getTime() + 1).toISOString();
    const refreshes = getPreviewPublisherRefreshes(state);
    for (const entity of entities) {
      refreshes[`${entity.entityType}:${entity.id}`] = refreshedAt;
    }
    for (const publication of state.publications) {
      if (publication.dispatchIssue !== 'actor_access_required') {
        continue;
      }
      publication.dispatchIssue = null;
      publication.occurrences = publication.occurrences.map((occurrence) => ({
        ...occurrence,
        dispatchIssue:
          occurrence.dispatchIssue === 'actor_access_required' ? null : occurrence.dispatchIssue,
      }));
    }
    return publisherEntitiesRefreshResponseSchema.parse({
      accepted: true,
      queuedCount: entities.length,
    });
  }
  if (url.pathname === '/publisher/entities/resolve' && method === 'POST') {
    const request = resolvePublisherEntitiesRequestSchema.parse(parseJsonBody(init));
    const entitiesByKey = new Map(
      listPreviewPublisherEntities(state).map((entity) => [
        `${entity.entityType}:${entity.id}`,
        entity,
      ]),
    );
    return resolvePublisherEntitiesResponseSchema.parse({
      items: [
        ...new Map(
          request.targets.map((target) => [`${target.entityType}:${target.id}`, target]),
        ).values(),
      ].flatMap((target) => {
        const entity = entitiesByKey.get(`${target.entityType}:${target.id}`);
        return entity ? [entity] : [];
      }),
    });
  }
  if (
    segments[0] !== 'publisher' ||
    segments[1] !== 'entities' ||
    (segments[2] !== 'chat' && segments[2] !== 'channel') ||
    !segments[3]
  ) {
    return PREVIEW_NOT_HANDLED;
  }

  const entityType = segments[2];
  const entityId = decodeURIComponent(segments[3]);
  if (
    state.publisherPolicyVariant === 'error' &&
    method === 'GET' &&
    (segments.length === 4 || (segments.length === 5 && segments[4] === 'policy'))
  ) {
    throw new ApiRequestError(503, '', 'Preview publisher policy unavailable');
  }
  const entity = buildPreviewPublisherEntity(state, entityType, entityId);
  if (!entity) {
    throw new ApiRequestError(404, '', 'Preview publisher entity not found');
  }
  if (entityType === 'chat' && segments[4] === 'auto-replies') {
    const rules = listPreviewPublisherAutoReplies(state, entityId);
    const contractV2 = url.searchParams.get('contractVersion') === '2';
    if (segments.length === 5 && method === 'GET') {
      return contractV2
        ? publisherAutoReplyListResponseV2Schema.parse({
            items: rules.map(presentPreviewPublisherAutoReplyV2),
            total: rules.length,
          })
        : publisherAutoReplyListResponseSchema.parse({
            items: rules.map(presentPreviewPublisherAutoReplyV1),
            total: rules.length,
          });
    }
    if (segments.length === 5 && method === 'POST') {
      const request = contractV2
        ? createPublisherAutoReplyV2RequestSchema.parse(parseJsonBody(init))
        : (() => {
            const legacy = createPublisherAutoReplyRequestSchema.parse(parseJsonBody(init));
            return {
              ...legacy,
              phrases: [legacy.phrase],
              matchInContext: false,
              fuzzyMatch: false,
            };
          })();
      assertPreviewPublisherAutoReplyFuzzyPhrases(request.phrases, request.fuzzyMatch);
      assertPreviewPublisherAutoReplyPhrasesAvailable(rules, request.phrases);
      const ruleId = `preview-auto-reply-${entityId}-${rules.length + 1}`;
      const content = buildPreviewPublisherAutoReplyContent(
        state,
        entityId,
        ruleId,
        1,
        request.content,
        null,
      );
      const legacyRule = publisherAutoReplyRuleSchema.parse({
        id: ruleId,
        chatId: entityId,
        phrase: request.phrases[0],
        enabled: request.enabled,
        cooldownSeconds: request.cooldownSeconds,
        version: 1,
        currentContentRevisionId: content.id,
        content,
        createdByUserId: 'preview-user',
        updatedByUserId: 'preview-user',
        createdAt: state.clock.now().toISOString(),
        updatedAt: state.clock.now().toISOString(),
        archivedAt: null,
      });
      const rule: PreviewPublisherAutoReplyStoredRule = {
        ...legacyRule,
        phrases: [...request.phrases],
        matchInContext: request.matchInContext,
        fuzzyMatch: request.fuzzyMatch,
      };
      rules.unshift(rule);
      return contractV2
        ? presentPreviewPublisherAutoReplyV2(rule)
        : presentPreviewPublisherAutoReplyV1(rule);
    }
    if (
      contractV2 &&
      segments.length === 6 &&
      segments[5] === 'match-preview' &&
      method === 'POST'
    ) {
      const request = publisherAutoReplyPreviewRequestSchema.parse(parseJsonBody(init));
      if (request.draft) {
        assertPreviewPublisherAutoReplyFuzzyPhrases(
          request.draft.phrases,
          request.draft.fuzzyMatch,
        );
      }
      return buildPreviewPublisherAutoReplyMatch(rules, request);
    }
    if (segments[5] === 'authoring-sessions') {
      const sessions = getPreviewPublisherAutoReplyAuthoring(state);
      if (segments.length === 6 && method === 'POST') {
        createPublisherAutoReplyAuthoringSessionRequestSchema.parse(parseJsonBody(init));
        const session = {
          id: `preview-auto-reply-authoring-${entityId}`,
          state: 'awaiting_start' as const,
          targetChatId: entityId,
          phrase: null,
          ruleId: null,
          contentRevisionId: null,
          expiresAt: new Date(state.clock.now().getTime() + 15 * 60_000).toISOString(),
        };
        sessions[entityId] = session;
        return publisherAutoReplyAuthoringSessionResponseSchema.parse({
          session,
          botUrl: `https://max.ru/publik_preview_bot?start=ar_${encodeURIComponent(entityId)}`,
        });
      }
      if (segments.length === 7 && segments[6] === 'current' && method === 'GET') {
        const session = sessions[entityId] ?? null;
        return publisherAutoReplyAuthoringSessionCurrentResponseSchema.parse({
          session,
          botUrl: session
            ? `https://max.ru/publik_preview_bot?start=ar_${encodeURIComponent(entityId)}`
            : null,
        });
      }
      if (segments.length === 7 && segments[6] === 'current' && method === 'DELETE') {
        sessions[entityId] = null;
        return publisherAutoReplyAuthoringSessionCurrentResponseSchema.parse({
          session: null,
          botUrl: null,
        });
      }
    }
    if (
      segments.length === 8 &&
      segments[5] &&
      segments[6] === 'assets' &&
      segments[7] &&
      method === 'GET'
    ) {
      const rule = rules.find((item) => item.id === decodeURIComponent(segments[5]));
      const assetId = decodeURIComponent(segments[7]);
      if (!rule?.content.images.some((asset) => asset.id === assetId)) {
        throw new ApiRequestError(404, '', 'Preview auto-reply asset not found');
      }
      return buildPreviewAutoReplyAssetBlob();
    }
    if (segments.length === 6 && segments[5] && method === 'GET') {
      const rule = rules.find((item) => item.id === decodeURIComponent(segments[5]));
      if (!rule) {
        throw new ApiRequestError(404, '', 'Preview auto-reply not found');
      }
      return contractV2
        ? presentPreviewPublisherAutoReplyV2(rule)
        : presentPreviewPublisherAutoReplyV1(rule);
    }
    if (segments.length === 6 && segments[5] && method === 'PATCH') {
      const ruleId = decodeURIComponent(segments[5]);
      const index = rules.findIndex((item) => item.id === ruleId);
      const current = rules[index];
      if (!current) {
        throw new ApiRequestError(404, '', 'Preview auto-reply not found');
      }
      const request = contractV2
        ? updatePublisherAutoReplyV2RequestSchema.parse(parseJsonBody(init))
        : (() => {
            const legacy = updatePublisherAutoReplyRequestSchema.parse(parseJsonBody(init));
            return {
              ...legacy,
              phrases: resolvePreviewLegacyPhraseUpdate(current, legacy.phrase),
              matchInContext: undefined,
              fuzzyMatch: undefined,
            };
          })();
      if (request.expectedVersion !== current.version) {
        throw publisherAutoReplyConflict(
          PUBLISHER_AUTO_REPLY_VERSION_CONFLICT_CODE,
          'Preview auto-reply version conflict',
        );
      }
      const phrases = request.phrases ?? current.phrases;
      assertPreviewPublisherAutoReplyFuzzyPhrases(
        phrases,
        request.fuzzyMatch ?? current.fuzzyMatch,
      );
      if (request.phrases) {
        assertPreviewPublisherAutoReplyPhrasesAvailable(rules, phrases, ruleId);
      }
      const version = current.version + 1;
      const content = request.content
        ? buildPreviewPublisherAutoReplyContent(
            state,
            entityId,
            ruleId,
            current.content.revision + 1,
            request.content,
            current.content,
          )
        : current.content;
      const updated: PreviewPublisherAutoReplyStoredRule = {
        ...current,
        phrase: phrases[0] ?? current.phrase,
        phrases: [...phrases],
        ...(request.matchInContext !== undefined ? { matchInContext: request.matchInContext } : {}),
        ...(request.fuzzyMatch !== undefined ? { fuzzyMatch: request.fuzzyMatch } : {}),
        ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
        ...(request.cooldownSeconds !== undefined
          ? { cooldownSeconds: request.cooldownSeconds }
          : {}),
        version,
        currentContentRevisionId: content.id,
        content,
        updatedAt: state.clock.now().toISOString(),
      };
      rules[index] = updated;
      return contractV2
        ? presentPreviewPublisherAutoReplyV2(updated)
        : presentPreviewPublisherAutoReplyV1(updated);
    }
    if (segments.length === 6 && segments[5] && method === 'DELETE') {
      const ruleId = decodeURIComponent(segments[5]);
      const index = rules.findIndex((item) => item.id === ruleId);
      const current = rules[index];
      if (!current) {
        throw new ApiRequestError(404, '', 'Preview auto-reply not found');
      }
      const request = archivePublisherAutoReplyRequestSchema.parse(parseJsonBody(init));
      if (request.expectedVersion !== current.version) {
        throw publisherAutoReplyConflict(
          PUBLISHER_AUTO_REPLY_VERSION_CONFLICT_CODE,
          'Preview auto-reply version conflict',
        );
      }
      rules.splice(index, 1);
      return archivePublisherAutoReplyResponseSchema.parse({
        id: current.id,
        archived: true,
        version: current.version + 1,
        archivedAt: state.clock.now().toISOString(),
      });
    }
  }
  if (segments.length === 4 && method === 'GET') {
    return entity;
  }
  if (segments.length === 5 && segments[4] === 'policy' && method === 'GET') {
    return entity.policy;
  }
  if (segments.length === 5 && segments[4] === 'refresh' && method === 'POST') {
    const refreshes = getPreviewPublisherRefreshes(state);
    const entityKey = `${entityType}:${entityId}`;
    const previousRefreshMs = Date.parse(refreshes[entityKey] ?? '');
    const requestedAtMs = state.clock.now().getTime();
    refreshes[entityKey] = new Date(
      Math.max(
        requestedAtMs + 1,
        Number.isFinite(previousRefreshMs) ? previousRefreshMs + 1 : requestedAtMs + 1,
      ),
    ).toISOString();
    return publisherEntityRefreshResponseSchema.parse({ accepted: true });
  }
  if (segments[4] === 'policy' && method === 'PATCH') {
    const request = updateManagedEntityPublicationPolicyRequestSchema.parse(parseJsonBody(init));
    if (state.publisherPolicyVariant === 'permission' && request.publikEnabled === true) {
      throw new ApiRequestError(
        409,
        JSON.stringify({
          statusCode: 409,
          code: 'BOT_CAPABILITY_REQUIRED',
          missingPermissions: [],
          featureKeys: ['publikEnabled'],
          checkedAt: null,
          blockerCode: 'bot_access_unconfirmed',
          stale: true,
          canRecheck: true,
        }),
        'Права Публика пока не подтверждены.',
      );
    }
    const policy = managedEntityPublicationPolicySchema.parse({
      ...entity.policy,
      ...(request.publikEnabled !== undefined ? { publikEnabled: request.publikEnabled } : {}),
      revision: entity.policy.revision + 1,
      updatedAt: state.clock.now().toISOString(),
    });
    getPreviewPublisherPolicies(state)[`${entityType}:${entityId}`] = policy;
    return policy;
  }
  if (segments[4] === 'modules' && method === 'PATCH') {
    const request = updatePublisherEntityModuleSettingsRequestSchema.parse(parseJsonBody(init));
    if (entityType === 'chat' && request.chatComments) {
      getPreviewPublisherChatComments(state)[entityId] = request.chatComments;
    }
    if (entityType === 'channel' && request.channelSuggestionsEnabled !== undefined) {
      getPreviewPublisherChannelSuggestions(state)[entityId] = request.channelSuggestionsEnabled;
    }
    if (entityType === 'channel' && request.channelCommentsEnabled !== undefined) {
      getPreviewPublisherChannelComments(state)[entityId] = request.channelCommentsEnabled;
    }
    if (entityType === 'chat' && request.autoRepliesEnabled !== undefined) {
      getPreviewPublisherAutoRepliesEnabled(state)[entityId] = request.autoRepliesEnabled;
    }
    const revision = entity.moduleSettings.revision + 1;
    getPreviewPublisherModuleRevisions(state)[`${entityType}:${entityId}`] = revision;
    return publisherEntityModuleSettingsSchema.parse({
      revision,
      chatComments:
        entityType === 'chat'
          ? (getPreviewPublisherChatComments(state)[entityId] ?? entity.moduleSettings.chatComments)
          : null,
      autoRepliesEnabled:
        entityType === 'chat'
          ? (getPreviewPublisherAutoRepliesEnabled(state)[entityId] ??
            entity.moduleSettings.autoRepliesEnabled)
          : null,
      channelCommentsEnabled:
        entityType === 'channel'
          ? (getPreviewPublisherChannelComments(state)[entityId] ?? false)
          : null,
      channelSuggestionsEnabled:
        entityType === 'channel'
          ? (getPreviewPublisherChannelSuggestions(state)[entityId] ?? false)
          : null,
    });
  }
  return PREVIEW_NOT_HANDLED;
};
