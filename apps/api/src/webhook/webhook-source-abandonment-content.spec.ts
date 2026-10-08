import type { WebhookEvent } from '../prisma/prisma-client';
import {
  inspectLegacyPostSealTextSource,
  inspectLegacyRecoverySource,
  inspectSourceAbandonmentPostSealSource,
  inspectSourceAbandonmentSource,
} from './webhook-legacy-source';
import { WebhookParser } from './webhook.parser';
import {
  SOURCE_ABANDONMENT_SOURCE_CLOSURE,
  sourceAbandonmentSourceClosureDigest,
} from '../scripts/source-abandonment-source-closure';
import { sourceAbandonmentDigest } from '../scripts/source-abandonment-live-protocol';

type Shape = 'plain' | 'share' | 'reply' | 'forward';
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
    type: shape === 'forward' ? 'forward' : 'reply',
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
  if (shape === 'reply' || shape === 'forward') message.link = link;
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
  it.each([0, 1, 10])(
    'accepts a modern flat forward with %i photos and no linked sender, holding only its outer human source',
    (photos) => {
      const f = fixture('forward');
      delete f.link.sender;
      f.linkedBody.text = 'Ordinary forwarded caption';
      f.linkedBody.attachments = Array.from({ length: photos }, (_, i) => ({
        type: 'image',
        payload: { photo_id: i + 1, token: 'opaque', url: `https://example.com/${i}` },
      }));
      const owner = f.owner();
      const before = structuredClone(owner);
      const expected = {
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      };
      expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
      expect(inspectLegacyRecoverySource(owner)).toBeNull();
      expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
      expect(owner).toEqual(before);
      delete f.message.sender;
      expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    },
  );

  it.each([
    null,
    [],
    'sender',
    {},
    { user_id: 'other', is_bot: 'false' },
    { user_id: 'other', is_bot: false, nested: {} },
  ])('does not treat a malformed supplied linked sender as omitted: %j', (sender) => {
    const f = fixture('forward');
    f.link.sender = sender;
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });

  it.each(['outer', 'linked'] as const)(
    'retains command checks in %s text when a forwarded sender is omitted',
    (source) => {
      const f = fixture('forward');
      delete f.link.sender;
      const body = source === 'outer' ? f.body : f.linkedBody;
      for (const text of ['/ban', 'Старт', 'бан']) {
        body.text = text;
        expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
      }
      body.text = 'особое';
      expect(
        inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
      ).toBeNull();
    },
  );

  it('keeps a channel forward without an outer sender outside the human source profile', () => {
    const f = fixture('forward');
    delete f.message.sender;
    f.message.recipient = { chat_id: '-111', chat_type: 'channel' };
    f.message.url = 'https://max.ru/example/outer-mid';
    const owner = f.owner();
    expect((owner.normalizedPayload as Record<string, unknown>).message).toMatchObject({
      entityType: 'channel',
      senderId: '',
    });
    const reasons: string[] = [];
    expect(inspectSourceAbandonmentSource(owner, (reason) => reasons.push(reason))).toBeNull();
    expect(reasons).toEqual(['source_objects_missing']);
    expect(inspectSourceAbandonmentPostSealSource(owner)).toBeNull();
  });

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

  it.each(['image', 'photo', 'video', 'ten-mixed'] as const)(
    'admits finite direct %s metadata with only the unchanged outer source authority',
    (kind) => {
      const f = fixture('plain');
      f.body.text = '';
      const photo = {
        type: kind === 'photo' ? 'photo' : 'image',
        payload: { photo_id: 42, token: 'opaque-photo', url: 'https://example.com/photo' },
      };
      const video = {
        type: 'video',
        payload: { id: 2 ** 60, token: 'opaque-video', url: 'https://example.com/video' },
        thumbnail: { url: 'https://example.com/thumbnail' },
        width: 1920,
        height: 1080,
        duration: 30,
      };
      f.body.attachments =
        kind === 'ten-mixed'
          ? Array.from({ length: 10 }, (_, i) => (i % 2 ? photo : video))
          : [kind === 'video' ? video : photo];
      const owner = f.owner();
      const before = structuredClone(owner);
      const expected = {
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      };
      expect(inspectLegacyRecoverySource(owner)).toEqual(expected);
      expect(inspectLegacyPostSealTextSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
      expect(owner).toEqual(before);
      for (const text of ['/ban', 'Старт', 'бан']) {
        f.body.text = text;
        expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
      }
      f.body.text = 'особое';
      expect(
        inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
      ).toBeNull();
    },
  );

  it.each([
    'eleven',
    'unknown-type',
    'nested-payload',
    'unknown-field',
    'unsafe-url',
    'credentials',
    'missing-token',
    'negative-size',
    'nested-thumbnail',
    'linked-message',
    'share-mix',
  ])('refuses unsupported direct media: %s', (fault) => {
    const f = fixture('plain');
    const payload: Record<string, unknown> = {
      id: 42,
      token: 'opaque-video',
      url: 'https://example.com/video',
    };
    const video: Record<string, unknown> = { type: 'video', payload };
    f.body.attachments = [video];
    if (fault === 'eleven') f.body.attachments = Array.from({ length: 11 }, () => video);
    if (fault === 'unknown-type') video.type = 'file';
    if (fault === 'nested-payload') payload.nested = { message_id: 'another' };
    if (fault === 'unknown-field') video.user_id = 'another';
    if (fault === 'unsafe-url') payload.url = 'http://example.com/video';
    if (fault === 'credentials') payload.url = 'https://user:password@example.com/video';
    if (fault === 'missing-token') delete payload.token;
    if (fault === 'negative-size') video.width = -1;
    if (fault === 'nested-thumbnail') video.thumbnail = { url: 'https://example.com', hidden: {} };
    if (fault === 'linked-message') f.message.link = f.link;
    if (fault === 'share-mix') f.body.attachments = [video, f.share];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });

  it('binds the added direct media profile to a new source closure digest', () => {
    const sourceSha = 'a'.repeat(40);
    const imageId = `sha256:${'b'.repeat(64)}`;
    const { directMedia: _media, ...withoutMedia } = SOURCE_ABANDONMENT_SOURCE_CLOSURE;
    const oldClosure = {
      ...withoutMedia,
      version: 3,
      source:
        'outer-human-text-with-strict-share-preview-or-flat-forward-or-reply-major-group-message',
      excluded: withoutMedia.excluded.map((value) =>
        value ===
        'non-image-or-video-direct-media-mixed-share-media-nested-links-and-unknown-content-shapes'
          ? 'direct-images-video-mixed-share-media-nested-links-and-unknown-content-shapes'
          : value,
      ),
    };
    expect(_media.scope).toBe('outer-recipient-chat-body-mid-sender-user-only');
    expect(sourceAbandonmentSourceClosureDigest(sourceSha, imageId)).not.toBe(
      sourceAbandonmentDigest({ sourceSha, imageId, closure: oldClosure }),
    );
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
