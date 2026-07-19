import {
  createManagedAutopostHubRuleRequestSchema,
  managedAutopostHubRuleDetailsSchema,
  updateManagedAutopostRuleRequestSchema,
  type ChatSummary,
  type ManagedAutopostHubRuleDetails,
  type ManagedAutopostPayload,
  type ManagedEntityType,
} from '@maxim/contracts';
import { PREVIEW_CHANNEL_TITLE, PREVIEW_CHAT_TITLE } from '../design-preview';
import type { PreviewState } from './preview-transport-state';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { cloneJson, parseJsonBody } from './preview-transport-shared';

export function findAutopostRule(
  rules: ManagedAutopostHubRuleDetails[],
  ruleId: string,
): ManagedAutopostHubRuleDetails | null {
  return rules.find((item) => item.id === ruleId && item.status !== 'DISABLED') ?? null;
}

export function resolvePreviewSource(
  state: PreviewState,
  entityType: ManagedEntityType,
  sourceChatId: string,
): ChatSummary | null {
  const sources = entityType === 'channel' ? state.channels : state.chats;
  return sources.find((item) => item.id === sourceChatId) ?? null;
}

export function resolvePreviewAutopostTargetPreviews(
  state: PreviewState,
  entityType: ManagedEntityType,
  sourceChatId: string,
  payload: ManagedAutopostPayload,
) {
  const source = resolvePreviewSource(state, entityType, sourceChatId);
  const sourcePreview = {
    id: sourceChatId,
    title: source?.title ?? (entityType === 'channel' ? PREVIEW_CHANNEL_TITLE : PREVIEW_CHAT_TITLE),
    entityType,
    link: source?.link ?? null,
    avatarUrl: source?.avatarUrl ?? null,
  };

  if (entityType === 'channel' || payload.targetMode === 'current') {
    return {
      sourcePreview,
      targetPreviews: [sourcePreview],
      targetOverflowCount: 0,
      targetChats: 1,
    };
  }

  if (payload.targetMode === 'all') {
    const previews = state.chats.slice(0, 3).map((chat) => ({
      id: chat.id,
      title: chat.title,
      entityType: 'chat' as const,
      link: chat.link ?? null,
      avatarUrl: chat.avatarUrl ?? null,
    }));
    return {
      sourcePreview,
      targetPreviews: previews,
      targetOverflowCount: Math.max(0, state.chats.length - previews.length),
      targetChats: Math.max(1, state.chats.length),
    };
  }

  const targetIds = payload.targetChatIds.length > 0 ? payload.targetChatIds : [sourceChatId];
  const previews = targetIds.slice(0, 3).map((targetId) => {
    const chat = state.chats.find((item) => item.id === targetId);
    return {
      id: targetId,
      title: chat?.title ?? `Чат ${targetId}`,
      entityType: 'chat' as const,
      link: chat?.link ?? null,
      avatarUrl: chat?.avatarUrl ?? null,
    };
  });
  return {
    sourcePreview,
    targetPreviews: previews,
    targetOverflowCount: Math.max(0, targetIds.length - previews.length),
    targetChats: Math.max(1, targetIds.length),
  };
}

export function buildPreviewAutopostRule(
  state: PreviewState,
  input: {
    id: string;
    sourceChatId: string;
    entityType: ManagedEntityType;
    title: string;
    payload: ManagedAutopostPayload;
    status?: ManagedAutopostHubRuleDetails['status'];
    revision?: number;
    createdAt?: string;
    updatedAt?: string;
  },
): ManagedAutopostHubRuleDetails {
  const nowIso = readPreviewClock(state.clock).toISOString();
  const textPreview = input.payload.text.replace(/\s+/gu, ' ').trim().slice(0, 160);
  const nextSendAt =
    input.payload.scheduledSlots
      .map((slot) => new Date(slot))
      .filter(
        (slot) =>
          Number.isFinite(slot.getTime()) &&
          slot.getTime() > readPreviewClock(state.clock).getTime(),
      )
      .sort((left, right) => left.getTime() - right.getTime())[0]
      ?.toISOString() ?? null;
  const targetBundle = resolvePreviewAutopostTargetPreviews(
    state,
    input.entityType,
    input.sourceChatId,
    input.payload,
  );

  return managedAutopostHubRuleDetailsSchema.parse({
    id: input.id,
    sourceChatId: input.sourceChatId,
    entityType: input.entityType,
    status: input.status ?? 'ACTIVE',
    title: input.title,
    textPreview:
      textPreview ||
      (input.payload.images.length > 0 || input.payload.imageEnabled ? 'Фото без текста' : 'Пусто'),
    textLength: input.payload.text.length,
    targetMode: input.payload.targetMode,
    applyToAllChats: input.payload.applyToAllChats,
    targetChatIds: input.payload.targetChatIds,
    targetChats: targetBundle.targetChats,
    hasImage: input.payload.images.length > 0 || input.payload.imageEnabled,
    imageCount: input.payload.images.length || (input.payload.imageEnabled ? 1 : 0),
    hasVideo: input.payload.mediaType === 'video',
    buttons: input.payload.buttons,
    scheduleTimezone: input.payload.scheduleTimezone,
    scheduledSlots: input.payload.scheduledSlots,
    nextSendAt,
    materializedCount: 0,
    revision: input.revision ?? 1,
    createdAt: input.createdAt ?? nowIso,
    updatedAt: input.updatedAt ?? nowIso,
    lastError: null,
    sourcePreview: targetBundle.sourcePreview,
    targetPreviews: targetBundle.targetPreviews,
    targetOverflowCount: targetBundle.targetOverflowCount,
    payload: input.payload,
  });
}

export function handleAutopostRulesRequest(
  state: PreviewState,
  segments: string[],
  url: URL,
  method: string,
  init: RequestInit,
) {
  if (segments.length === 1) {
    if (method === 'GET') {
      const entityType = url.searchParams.get('entityType');
      const status = url.searchParams.get('status');
      const sourceChatId = url.searchParams.get('sourceChatId');
      return cloneJson(
        state.autopostRules.filter((rule) => {
          if (rule.status === 'DISABLED') {
            return false;
          }
          if (
            (entityType === 'chat' || entityType === 'channel') &&
            rule.entityType !== entityType
          ) {
            return false;
          }
          if (status && rule.status !== status) {
            return false;
          }
          if (sourceChatId && rule.sourceChatId !== sourceChatId) {
            return false;
          }
          return true;
        }),
      );
    }

    if (method === 'POST') {
      const payload = createManagedAutopostHubRuleRequestSchema.parse(parseJsonBody(init));
      const created = buildPreviewAutopostRule(state, {
        id: `autopost-preview-${readPreviewClock(state.clock).getTime()}`,
        sourceChatId: payload.sourceChatId,
        entityType: payload.entityType,
        title: payload.title,
        payload: payload.payload,
      });
      state.autopostRules = [created, ...state.autopostRules];
      return cloneJson(created);
    }
  }

  const ruleId = segments[1] ? decodeURIComponent(segments[1]) : '';
  const existing = ruleId ? findAutopostRule(state.autopostRules, ruleId) : null;
  if (!existing) {
    throw new Error(`Preview autopost rule not found: ${ruleId}`);
  }

  if (segments.length === 2 && method === 'GET') {
    return cloneJson(existing);
  }

  if (segments.length === 2 && method === 'PUT') {
    const payload = updateManagedAutopostRuleRequestSchema.parse(parseJsonBody(init));
    const updated = buildPreviewAutopostRule(state, {
      id: existing.id,
      sourceChatId: existing.sourceChatId,
      entityType: existing.entityType,
      title: payload.title ?? existing.title,
      payload: payload.payload ?? existing.payload,
      status: payload.status ?? existing.status,
      revision: existing.revision + (payload.payload ? 1 : 0),
      createdAt: existing.createdAt,
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.autopostRules = state.autopostRules.map((rule) =>
      rule.id === existing.id ? updated : rule,
    );
    return cloneJson(updated);
  }

  if (segments.length === 2 && method === 'DELETE') {
    const disabled = managedAutopostHubRuleDetailsSchema.parse({
      ...existing,
      status: 'DISABLED',
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.autopostRules = state.autopostRules.map((rule) =>
      rule.id === existing.id ? disabled : rule,
    );
    return cloneJson(disabled);
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

export const handleAutopostsPreviewRequest: PreviewRequestHandler = (context) => {
  const { segments, state, url, method, init } = context;
  if (segments[0] === 'autopost-rules') {
    return handleAutopostRulesRequest(state, segments, url, method, init);
  }
  if (
    (segments[0] === 'chats' || segments[0] === 'channels') &&
    segments[1] &&
    segments[2] === 'autopost-rules'
  ) {
    const entityType = segments[0] === 'channels' ? 'channel' : 'chat';
    const sourceChatId = decodeURIComponent(segments[1]);
    const scopedSegments = ['autopost-rules', ...segments.slice(3)];
    const ruleId = scopedSegments[1] ? decodeURIComponent(scopedSegments[1]) : '';
    if (ruleId) {
      const rule = findAutopostRule(state.autopostRules, ruleId);
      if (!rule || rule.entityType !== entityType || rule.sourceChatId !== sourceChatId) {
        throw new Error(`Preview autopost rule not found: ${ruleId}`);
      }
    }
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set('entityType', entityType);
    scopedUrl.searchParams.set('sourceChatId', sourceChatId);
    return handleAutopostRulesRequest(state, scopedSegments, scopedUrl, method, init);
  }
  return PREVIEW_NOT_HANDLED;
};
