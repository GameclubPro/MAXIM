import { describe, expect, it } from 'vitest';
import {
  canonicalKaravanMarketplaceJson,
  karavanMarketplaceActorAccessRequestSchema,
  karavanMarketplaceActorAccessResponseSchema,
  karavanMarketplaceAuthorityRequestSchema,
  karavanMarketplaceCreateSchema,
  karavanMarketplaceHandoffIssueSchema,
  karavanMarketplaceSetupSchema,
} from '../src/karavan-marketplace.js';

describe('Karavan command boundary', () => {
  const scope = {
    proofId: 'x'.repeat(43),
    actorMaxUserId: '123',
    chatId: '-9007199254740993',
    commandId: 'operation:create',
    action: 'create_marketplace',
    marketplaceId: null,
    expectedBindingGeneration: null,
    payloadHash: 'a'.repeat(64),
  };
  it('retains exact large chat IDs and rejects fabricated privilege fields', () => {
    expect(karavanMarketplaceAuthorityRequestSchema.parse(scope).chatId).toBe('-9007199254740993');
    expect(
      karavanMarketplaceAuthorityRequestSchema.safeParse({ ...scope, isAdmin: true }).success,
    ).toBe(false);
    expect(
      karavanMarketplaceAuthorityRequestSchema.safeParse({
        ...scope,
        chatId: Number('-9007199254740993'),
      }).success,
    ).toBe(false);
    expect(
      karavanMarketplaceAuthorityRequestSchema.safeParse({ ...scope, action: 'bind_chat' }).success,
    ).toBe(false);
  });
  it('hash input is recursive canonical JSON; undefined and custom prototypes cannot disappear', () => {
    expect(canonicalKaravanMarketplaceJson({ b: [{ z: 1, a: false }], a: null })).toBe(
      '{"a":null,"b":[{"a":false,"z":1}]}',
    );
    for (const input of [{ a: undefined }, { a: NaN }, new Date()])
      expect(() => canonicalKaravanMarketplaceJson(input)).toThrow();
  });
  it('applies the same create defaults before signing and prevents duplicate chat selections', () => {
    const create = {
      name: '  Магазин  ',
      rules: { text: 'Правила', allowedCategoryIds: ['services'], allowedSubcategoryIds: [] },
    };
    expect(
      karavanMarketplaceCreateSchema.parse({ ...create, commandId: 'operation:create' }),
    ).toMatchObject({
      name: 'Магазин',
      networkId: null,
      description: null,
      admissionPolicy: 'applications',
      rules: { categoryOrder: [] },
    });
    expect(
      karavanMarketplaceSetupSchema.safeParse({
        operationId: 'f07ca391-24bb-4f3b-b64e-e49ed0fdbed6',
        chatIds: ['-1', '-1'],
        create,
      }).success,
    ).toBe(false);
  });

  it('accepts explicit buyer destinations without allowing a caller-supplied return URL', () => {
    const input = {
      commandId: 'operation:preview',
      marketplaceId: 'f07ca391-24bb-4f3b-b64e-e49ed0fdbed6',
    };
    for (const destination of ['view', 'preview']) {
      expect(
        karavanMarketplaceHandoffIssueSchema.parse({ ...input, destination }).destination,
      ).toBe(destination);
      expect(
        karavanMarketplaceHandoffIssueSchema.safeParse({
          ...input,
          destination,
          returnUrl: 'https://max.ru/other_bot',
        }).success,
      ).toBe(false);
    }
  });
});

describe('Karavan current chat administrator access boundary', () => {
  const request = {
    actorMaxUserId: '9007199254740993',
    chatId: '-9007199254740993',
    botId: 'major_bot',
    authorityEpoch: 'a'.repeat(64),
    verifiedAt: '2026-01-01T00:00:00.000Z',
    bindingGeneration: 7,
  };
  const response = {
    ...request,
    allowed: true,
    reason: 'admin',
    checkedAt: '2026-01-01T01:00:00.000Z',
    expiresAt: '2026-01-01T01:00:15.000Z',
  };

  it('keeps exact actor/chat IDs and every original binding field', () => {
    expect(karavanMarketplaceActorAccessRequestSchema.parse(request)).toEqual(request);
    expect(karavanMarketplaceActorAccessResponseSchema.parse(response)).toEqual(response);
    for (const field of Object.keys(request)) {
      const incomplete = { ...request } as Record<string, unknown>;
      delete incomplete[field];
      expect(karavanMarketplaceActorAccessRequestSchema.safeParse(incomplete).success).toBe(false);
    }
    for (const invalid of [
      { isAdmin: true },
      { role: 'owner' },
      { chatId: Number(request.chatId) },
      { actorMaxUserId: Number(request.actorMaxUserId) },
      { bindingGeneration: 0 },
      { bindingGeneration: 1.5 },
      { authorityEpoch: 'other' },
    ])
      expect(
        karavanMarketplaceActorAccessRequestSchema.safeParse({ ...request, ...invalid }).success,
      ).toBe(false);
  });

  it('rejects contradictory decisions, added privileges and extended validity', () => {
    for (const invalid of [
      { allowed: false },
      { reason: 'not_admin' },
      { role: 'owner' },
      { expiresAt: response.checkedAt },
      { expiresAt: '2026-01-01T01:00:15.001Z' },
    ])
      expect(
        karavanMarketplaceActorAccessResponseSchema.safeParse({ ...response, ...invalid }).success,
      ).toBe(false);
    expect(
      karavanMarketplaceActorAccessResponseSchema.parse({
        ...response,
        allowed: false,
        reason: 'not_admin',
      }).allowed,
    ).toBe(false);
  });
});
