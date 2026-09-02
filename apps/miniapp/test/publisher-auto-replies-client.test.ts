import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublisherAutoReplyRuleV2 } from '@maxim/contracts/publisher-auto-replies';
import { ApiRequestError } from '../src/lib/api-request-error';
import { PREVIEW_CHAT_ID } from '../src/lib/design-preview';
import {
  archivePublisherAutoReply,
  createPublisherAutoReply,
  createPublisherAutoReplyAuthoringSession,
  getCurrentPublisherAutoReplyAuthoringSession,
  getPublisherAutoReply,
  getPublisherAutoReplyAsset,
  listPublisherAutoReplies,
  previewPublisherAutoReplyMatch,
  updatePublisherAutoReply,
} from '../src/lib/api/publisher-auto-replies-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import type { ApiRequestInit, ApiTransport } from '../src/lib/api/transport';

const CHAT_ID = 'chat/with?symbols';
const NOW = '2026-08-29T12:00:00.000Z';
const previewClock = { now: () => new Date(NOW) };

function buildRule(overrides: Partial<PublisherAutoReplyRuleV2> = {}): PublisherAutoReplyRuleV2 {
  return {
    id: 'rule-1',
    chatId: CHAT_ID,
    phrases: ['Прайс', 'Сколько стоит'],
    matchInContext: true,
    fuzzyMatch: false,
    enabled: true,
    cooldownSeconds: 30,
    version: 1,
    currentContentRevisionId: 'content-1',
    content: {
      id: 'content-1',
      revision: 1,
      text: '**Актуальный прайс**',
      textFormat: 'markdown',
      images: [],
      buttons: [],
      createdAt: NOW,
    },
    createdByUserId: 'user-1',
    updatedByUserId: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function createSequentialTransport(
  responses: unknown[],
  calls: Array<{ path: string; init?: ApiRequestInit }>,
): ApiTransport {
  return {
    request: async (path, init) => {
      calls.push({ path, init });
      return responses.shift();
    },
    requestKeepalive: () => undefined,
  };
}

test('publisher auto-reply v2 CRUD opts into the versioned contract and keeps mode flags', async () => {
  const created = buildRule();
  const updated = buildRule({ version: 2, fuzzyMatch: true });
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api = createSequentialTransport(
    [
      { items: [created], total: 1 },
      created,
      created,
      updated,
      { id: updated.id, archived: true, version: 3, archivedAt: NOW },
    ],
    calls,
  );

  assert.equal((await listPublisherAutoReplies(api, CHAT_ID)).items[0]?.phrases.length, 2);
  assert.equal((await getPublisherAutoReply(api, CHAT_ID, created.id)).id, created.id);
  await createPublisherAutoReply(api, CHAT_ID, {
    requestId: 'request-create',
    phrases: created.phrases,
    matchInContext: true,
    fuzzyMatch: false,
    enabled: true,
    cooldownSeconds: 30,
    content: { text: created.content.text, textFormat: 'markdown' },
  });
  await updatePublisherAutoReply(api, CHAT_ID, created.id, {
    requestId: 'request-update',
    expectedVersion: 1,
    fuzzyMatch: true,
  });
  await archivePublisherAutoReply(api, CHAT_ID, created.id, {
    requestId: 'request-delete',
    expectedVersion: 2,
  });

  assert.equal(
    calls[0]?.path,
    '/publisher/entities/chat/chat%2Fwith%3Fsymbols/auto-replies?contractVersion=2',
  );
  assert.equal(
    calls[1]?.path,
    '/publisher/entities/chat/chat%2Fwith%3Fsymbols/auto-replies/rule-1?contractVersion=2',
  );
  assert.equal(calls[2]?.path, calls[0]?.path);
  assert.equal(
    calls[3]?.path,
    '/publisher/entities/chat/chat%2Fwith%3Fsymbols/auto-replies/rule-1?contractVersion=2',
  );
  assert.equal(
    calls[4]?.path,
    '/publisher/entities/chat/chat%2Fwith%3Fsymbols/auto-replies/rule-1',
  );
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    requestId: 'request-create',
    phrases: ['Прайс', 'Сколько стоит'],
    matchInContext: true,
    fuzzyMatch: false,
    enabled: true,
    cooldownSeconds: 30,
    content: { text: '**Актуальный прайс**', textFormat: 'markdown', images: [], buttons: [] },
  });
});

test('publisher auto-reply client sends an unsaved draft to match preview', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api = createSequentialTransport(
    [
      {
        outcome: 'matched',
        selected: {
          ruleId: null,
          phrase: 'Прайс',
          matchKind: 'fuzzy_context',
          distance: 1,
          matchedDraft: true,
        },
      },
    ],
    calls,
  );

  const result = await previewPublisherAutoReplyMatch(api, CHAT_ID, {
    message: 'Пришлите праиз',
    draft: { phrases: ['Прайс'], matchInContext: true, fuzzyMatch: true, enabled: false },
  });

  assert.equal(result.outcome, 'matched');
  assert.equal(result.selected?.matchedDraft, true);
  assert.equal(
    calls[0]?.path,
    '/publisher/entities/chat/chat%2Fwith%3Fsymbols/auto-replies/match-preview?contractVersion=2',
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    message: 'Пришлите праиз',
    draft: { phrases: ['Прайс'], matchInContext: true, fuzzyMatch: true, enabled: false },
  });
});

test('auto-reply assets stay behind authenticated v2 blob requests', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const blob = new Blob(['image'], { type: 'image/png' });
  const api = createSequentialTransport([blob], calls);

  assert.equal(await getPublisherAutoReplyAsset(api, CHAT_ID, 'rule-1', 'asset-1'), blob);
  assert.equal(
    calls[0]?.path,
    '/publisher/entities/chat/chat%2Fwith%3Fsymbols/auto-replies/rule-1/assets/asset-1?contractVersion=2',
  );
  assert.equal(calls[0]?.init?.responseType, 'blob');
});

test('bot authoring keeps its chat-scoped handoff outside the rule contract version', async () => {
  const session = {
    id: 'session-1',
    state: 'awaiting_start' as const,
    targetChatId: CHAT_ID,
    phrase: null,
    ruleId: null,
    contentRevisionId: null,
    expiresAt: '2026-08-29T12:15:00.000Z',
  };
  const botUrl = 'https://max.ru/publik_bot?start=ar_session';
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api = createSequentialTransport(
    [
      { session, botUrl },
      { session, botUrl },
    ],
    calls,
  );

  const created = await createPublisherAutoReplyAuthoringSession(api, CHAT_ID, {
    requestId: 'request-authoring',
  });
  const current = await getCurrentPublisherAutoReplyAuthoringSession(api, CHAT_ID);

  assert.equal(created.session.targetChatId, CHAT_ID);
  assert.equal(current.session?.id, session.id);
  assert.doesNotMatch(calls[0]?.path ?? '', /contractVersion/u);
  assert.doesNotMatch(calls[1]?.path ?? '', /contractVersion/u);
});

test('preview transport persists v2 aliases, modes, and optimistic versions', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const initial = await listPublisherAutoReplies(api, PREVIEW_CHAT_ID);
  assert.deepEqual(initial.items[0]?.phrases, ['Прайс', 'Стоимость']);
  assert.equal(initial.items[0]?.matchInContext, true);

  const created = await createPublisherAutoReply(api, PREVIEW_CHAT_ID, {
    requestId: 'preview-create-1',
    phrases: ['Доставка', 'Когда привезут'],
    matchInContext: true,
    fuzzyMatch: false,
    enabled: true,
    cooldownSeconds: 45,
    content: { text: 'Доставим сегодня' },
  });
  assert.deepEqual(created.phrases, ['Доставка', 'Когда привезут']);
  assert.equal(created.matchInContext, true);
  assert.equal((await getPublisherAutoReply(api, PREVIEW_CHAT_ID, created.id)).id, created.id);

  const updated = await updatePublisherAutoReply(api, PREVIEW_CHAT_ID, created.id, {
    requestId: 'preview-update-1',
    expectedVersion: created.version,
    phrases: ['Доставка', 'Срок доставки'],
    fuzzyMatch: true,
  });
  assert.equal(updated.version, created.version + 1);
  assert.deepEqual(updated.phrases, ['Доставка', 'Срок доставки']);
  assert.equal(updated.matchInContext, true);
  assert.equal(updated.fuzzyMatch, true);

  const listed = await listPublisherAutoReplies(api, PREVIEW_CHAT_ID);
  assert.deepEqual(listed.items.find((rule) => rule.id === created.id)?.phrases, updated.phrases);
});

test('preview transport retains the singular v1 rule shape on unversioned paths', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const basePath = `/publisher/entities/chat/${encodeURIComponent(PREVIEW_CHAT_ID)}/auto-replies`;
  const initial = (await api.request(basePath)) as { items: Array<Record<string, unknown>> };
  assert.equal(initial.items[0]?.phrase, 'Прайс');
  assert.equal('phrases' in (initial.items[0] ?? {}), false);

  const initialRuleId = String(initial.items[0]?.id);
  await assert.rejects(
    api.request(`${basePath}/${encodeURIComponent(initialRuleId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        requestId: 'preview-v1-incompatible-update',
        expectedVersion: 1,
        phrase: 'Тарифы',
      }),
    }),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.status === 409 &&
      error.code === 'PUBLISHER_AUTO_REPLY_CLIENT_UPGRADE_REQUIRED',
  );
  const patched = (await api.request(`${basePath}/${encodeURIComponent(initialRuleId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      requestId: 'preview-v1-update',
      expectedVersion: 1,
      phrase: 'ПРАЙС',
      enabled: false,
    }),
  })) as Record<string, unknown>;
  assert.equal(patched.phrase, 'Прайс');
  assert.equal(patched.enabled, false);
  assert.equal('phrases' in patched, false);

  const created = (await api.request(basePath, {
    method: 'POST',
    body: JSON.stringify({
      requestId: 'preview-v1-create',
      phrase: 'Контакты',
      content: { text: 'Свяжитесь с нами' },
    }),
  })) as Record<string, unknown>;
  assert.equal(created.phrase, 'Контакты');
  assert.equal('phrases' in created, false);

  const v2 = await listPublisherAutoReplies(api, PREVIEW_CHAT_ID);
  const migrated = v2.items.find((rule) => rule.id === created.id);
  assert.deepEqual(migrated?.phrases, ['Контакты']);
  assert.equal(migrated?.matchInContext, false);
  assert.equal(migrated?.fuzzyMatch, false);
  const patchedV2 = v2.items.find((rule) => rule.id === initialRuleId);
  assert.deepEqual(patchedV2?.phrases, ['Прайс', 'Стоимость']);
  assert.equal(patchedV2?.matchInContext, true);
});

test('preview transport exposes all four deterministic match modes', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const createdRule = await createPublisherAutoReply(api, PREVIEW_CHAT_ID, {
    requestId: 'preview-match-rule',
    phrases: ['Доставка'],
    matchInContext: true,
    fuzzyMatch: true,
    content: { text: 'Ответ про доставку' },
  });

  const examples = [
    ['ДОСТАВКА', 'exact_full', 0],
    ['Когда доставка сегодня?', 'exact_context', 0],
    ['ДОСТАВККА', 'fuzzy_full', 1],
    ['Когда доставкка сегодня?', 'fuzzy_context', 1],
  ] as const;
  for (const [message, matchKind, distance] of examples) {
    const result = await previewPublisherAutoReplyMatch(api, PREVIEW_CHAT_ID, { message });
    assert.equal(result.outcome, 'matched');
    assert.equal(result.selected?.phrase, 'Доставка');
    assert.equal(result.selected?.matchKind, matchKind);
    assert.equal(result.selected?.distance, distance);
    assert.equal(result.selected?.matchedDraft, false);
  }

  const overTokenBudget = await previewPublisherAutoReplyMatch(api, PREVIEW_CHAT_ID, {
    message: [...Array.from({ length: 256 }, () => 'слово'), 'прайс'].join(' '),
  });
  assert.deepEqual(overTokenBudget, { outcome: 'no_match', selected: null });

  const draft = await previewPublisherAutoReplyMatch(api, PREVIEW_CHAT_ID, {
    message: 'Есть гарантия?',
    draft: {
      phrases: ['Гарантия'],
      matchInContext: true,
      fuzzyMatch: false,
      enabled: true,
    },
  });
  assert.equal(draft.outcome, 'matched');
  assert.equal(draft.selected?.ruleId, null);
  assert.equal(draft.selected?.phrase, 'Гарантия');
  assert.equal(draft.selected?.matchKind, 'exact_context');
  assert.equal(draft.selected?.matchedDraft, true);

  const editedDraft = await previewPublisherAutoReplyMatch(api, PREVIEW_CHAT_ID, {
    message: 'Гарантия',
    draft: {
      ruleId: createdRule.id,
      phrases: ['Гарантия'],
      matchInContext: false,
      fuzzyMatch: false,
      enabled: true,
    },
  });
  assert.equal(editedDraft.outcome, 'matched');
  assert.equal(editedDraft.selected?.ruleId, null);
  assert.equal(editedDraft.selected?.matchedDraft, true);

  const disabledDraft = await previewPublisherAutoReplyMatch(api, PREVIEW_CHAT_ID, {
    message: 'Уникальная выключенная фраза',
    draft: {
      phrases: ['Уникальная выключенная фраза'],
      matchInContext: false,
      fuzzyMatch: false,
      enabled: false,
    },
  });
  assert.deepEqual(disabledDraft, { outcome: 'no_match', selected: null });
});

test('preview transport enforces the production fuzzy phrase minimum', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const assertFuzzyPhraseError = (error: unknown) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'PUBLISHER_AUTO_REPLY_FUZZY_PHRASE_TOO_SHORT');
    return true;
  };

  await assert.rejects(
    createPublisherAutoReply(api, PREVIEW_CHAT_ID, {
      requestId: 'preview-short-fuzzy-create',
      phrases: ['Цена'],
      matchInContext: false,
      fuzzyMatch: true,
      content: { text: 'Ответ' },
    }),
    assertFuzzyPhraseError,
  );

  const current = (await listPublisherAutoReplies(api, PREVIEW_CHAT_ID)).items[0]!;
  await assert.rejects(
    updatePublisherAutoReply(api, PREVIEW_CHAT_ID, current.id, {
      requestId: 'preview-short-fuzzy-update',
      expectedVersion: current.version,
      phrases: ['Цена'],
      fuzzyMatch: true,
    }),
    assertFuzzyPhraseError,
  );

  await assert.rejects(
    previewPublisherAutoReplyMatch(api, PREVIEW_CHAT_ID, {
      message: 'Цена',
      draft: {
        phrases: ['Цена'],
        matchInContext: false,
        fuzzyMatch: true,
        enabled: true,
      },
    }),
    assertFuzzyPhraseError,
  );
});

test('preview transport exposes distinct version and phrase conflict codes', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const current = (await listPublisherAutoReplies(api, PREVIEW_CHAT_ID)).items[0]!;

  await assert.rejects(
    updatePublisherAutoReply(api, PREVIEW_CHAT_ID, current.id, {
      requestId: 'preview-version-conflict',
      expectedVersion: current.version + 1,
      fuzzyMatch: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'PUBLISHER_AUTO_REPLY_VERSION_CONFLICT');
      return true;
    },
  );
  await assert.rejects(
    createPublisherAutoReply(api, PREVIEW_CHAT_ID, {
      requestId: 'preview-phrase-conflict',
      phrases: ['  ПРАЙС  '],
      matchInContext: false,
      fuzzyMatch: false,
      content: { text: 'Другой ответ' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT');
      return true;
    },
  );
});
