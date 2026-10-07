import type { WebhookEvent } from '../prisma/prisma-client';
import {
  inspectLegacyPostSealTextSource,
  inspectLegacyRecoverySource,
  inspectSourceAbandonmentPostSealSource,
  inspectSourceAbandonmentSource,
} from './webhook-legacy-source';
import { WebhookParser } from './webhook.parser';

type Shape = 'plain' | 'share' | 'reply';
type Source = Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>;

function fixture(shape: Shape) {
  const at = Date.parse('2026-10-06T12:00:00.000Z');
  const body: Record<string, unknown> = { mid: 'outer-mid', text: '  Ordinary   source text  ' };
  const share: Record<string, unknown> = {
    type: 'share',
    payload: { url: 'https://example.com/article', token: 'opaque-share-token' },
    title: 'A preview title',
    description: null,
    image_url: 'https://example.com/preview.jpg',
  };
  const linkedBody: Record<string, unknown> = {
    mid: 'quoted-mid',
    text: '',
    attachments: [
      { type: 'image', payload: { photo_id: 'photo', url: 'https://example.com/a.jpg' } },
    ],
  };
  const link: Record<string, unknown> = {
    type: 'reply',
    chat_id: '-222',
    sender: { user_id: 'quoted-user', is_bot: false },
    message: linkedBody,
  };
  const message: Record<string, unknown> = {
    sender: { user_id: 'outer-user', is_bot: false },
    recipient: { chat_id: '-111', chat_type: 'chat' },
    timestamp: at,
    body,
  };
  if (shape === 'share') {
    body.attachments = [share];
    body.markup = [
      { type: 'heading', from: 2, length: 8 },
      { type: 'strong', from: 2, length: 8 },
      { type: 'link', from: 2, length: 8, url: 'https://example.com/article' },
    ];
  }
  if (shape === 'reply') message.link = link;
  const raw = { update_type: 'message_created', timestamp: at, message };
  const owner = (): Source => ({
    botId: 'major',
    createdAt: new Date(at + 1000),
    rawPayload: structuredClone(raw) as never,
    normalizedPayload: new WebhookParser().parse(structuredClone(raw), { botId: 'major' }) as never,
  });
  return { at, raw, message, body, share, link, linkedBody, owner };
}

describe('modern source content profile', () => {
  it.each<Shape>(['plain', 'share', 'reply'])(
    'proves %s against its unchanged raw payload and returns only the outer source',
    (shape) => {
      const f = fixture(shape);
      const owner = f.owner();
      const original = structuredClone(owner);
      const expected = {
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      };
      expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
      expect(owner).toEqual(original);
      if (shape !== 'plain') {
        expect(inspectLegacyRecoverySource(owner)).toBeNull();
        expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
      }
    },
  );

  it.each<Shape>(['share', 'reply'])(
    'requires both original and normalized representations for %s',
    (shape) => {
      const f = fixture(shape);
      const owner = f.owner();
      const normalized = owner.normalizedPayload as unknown as {
        message: { text: string };
      };
      normalized.message.text = 'Forged normalized content';
      expect(inspectSourceAbandonmentSource(owner)).toBeNull();
      const mismatch = f.owner();
      mismatch.rawPayload = { different: 'raw' };
      expect(inspectSourceAbandonmentSource(mismatch)).toBeNull();
    },
  );

  it.each<Shape>(['share', 'reply'])(
    'permits edited/future-clock provenance only in the already-held %s path',
    (shape) => {
      const f = fixture(shape);
      f.raw.update_type = 'message_edited';
      const owner = f.owner();
      owner.createdAt = new Date(f.at - 1);
      expect(inspectSourceAbandonmentSource(owner)).toBeNull();
      expect(inspectSourceAbandonmentPostSealSource(owner)).not.toBeNull();
      expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
    },
  );

  it.each([
    'unknown-item',
    'unknown-payload',
    'nested-metadata',
    'http',
    'credentials',
    'bad-preview',
    'long-token',
    'two-shares',
    'mixed-media',
    'share-and-link',
    'active-markup',
  ])('refuses unsupported share content: %s', (fault) => {
    const f = fixture('share');
    const payload = f.share.payload as Record<string, unknown>;
    if (fault === 'unknown-item') f.share.hidden = {};
    if (fault === 'unknown-payload') payload.hidden = {};
    if (fault === 'nested-metadata') f.share.title = { text: 'nested' };
    if (fault === 'http') payload.url = 'http://example.com';
    if (fault === 'credentials') payload.url = 'https://user:pass@example.com';
    if (fault === 'bad-preview') f.share.image_url = 'javascript:alert(1)';
    if (fault === 'long-token') payload.token = 'x'.repeat(32769);
    if (fault === 'two-shares') f.body.attachments = [f.share, f.share];
    if (fault === 'mixed-media') f.body.attachments = [f.share, { type: 'image', payload: {} }];
    if (fault === 'share-and-link') f.message.link = f.link;
    if (fault === 'active-markup')
      f.body.markup = [{ type: 'user_mention', from: 2, length: 3, user_id: 'other-user' }];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each([
    'nested-link',
    'unknown-link',
    'missing-sender',
    'sender-kind',
    'unknown-image',
    'image-extra-field',
    'eleven-images',
    'direct-image',
  ])('refuses unsupported reply content: %s', (fault) => {
    const f = fixture('reply');
    if (fault === 'nested-link') f.linkedBody.link = { type: 'forward' };
    if (fault === 'unknown-link') f.link.hidden = {};
    if (fault === 'missing-sender') delete f.link.sender;
    if (fault === 'sender-kind') f.link.sender = { user_id: 'quoted-user', is_bot: 'false' };
    if (fault === 'unknown-image') f.linkedBody.attachments = [{ type: 'video', payload: {} }];
    if (fault === 'image-extra-field')
      f.linkedBody.attachments = [{ type: 'image', payload: { photo_id: 'photo', hidden: {} } }];
    if (fault === 'eleven-images')
      f.linkedBody.attachments = Array.from({ length: 11 }, () => ({
        type: 'image',
        payload: { photo_id: 'photo' },
      }));
    if (fault === 'direct-image') f.body.attachments = f.linkedBody.attachments;
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each<Shape>(['share', 'reply'])(
    'rejects default and configured outer commands in %s',
    (shape) => {
      const f = fixture(shape);
      for (const text of [' /command ', 'Старт', 'бан']) {
        f.body.text = text;
        delete f.body.markup;
        expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
      }
      f.body.text = 'особое';
      expect(
        inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
      ).toBeNull();
    },
  );

  it('refuses commands in quoted reply text even though the parser excludes it', () => {
    const f = fixture('reply');
    f.linkedBody.text = 'бан';
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    f.linkedBody.text = 'особое';
    expect(
      inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
    ).toBeNull();
  });

  it('retains legacy direct-image support while modern direct images remain excluded', () => {
    const f = fixture('plain');
    f.body.attachments = [{ type: 'image', payload: { photo_id: 'photo' } }];
    expect(inspectLegacyRecoverySource(f.owner())).not.toBeNull();
    expect(inspectLegacyPostSealTextSource(f.owner())).not.toBeNull();
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });

  it('validates link bounds against original UTF-16 text only in the modern profile', () => {
    const f = fixture('plain');
    f.body.text = '😀A';
    f.body.markup = [{ type: 'link', from: 2, length: 1, url: 'https://example.com' }];
    expect(inspectSourceAbandonmentSource(f.owner())).not.toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).not.toBeNull();
    expect(inspectLegacyRecoverySource(f.owner())).toBeNull();
    expect(inspectLegacyPostSealTextSource(f.owner())).toBeNull();
  });

  it.each([
    { url: 'http://example.com' },
    { url: 'javascript:alert(1)' },
    { url: 'https://user:pass@example.com' },
    { url: 'https://exa\nmple.com' },
    { url: `https://example.com/${'x'.repeat(2048)}` },
    { from: -1 },
    { from: 1.5 },
    { from: Number.MAX_SAFE_INTEGER + 1 },
    { length: 0 },
    { length: 1000 },
    { user_id: 'secondary-user' },
  ])('refuses invalid modern link formatting %#', (patch) => {
    const f = fixture('share');
    f.body.markup = [{ type: 'link', from: 2, length: 8, url: 'https://example.com', ...patch }];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });
});
