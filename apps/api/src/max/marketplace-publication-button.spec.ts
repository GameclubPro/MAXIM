import {
  appendMarketplacePublicationButton,
  isMarketplacePublicationTarget,
} from './marketplace-publication-button';
import type { MaxSendMessageOptions } from './max-client.service';

const url =
  'https://max.ru/svyazka_bot?startapp=listing_channel_10000000-0000-4000-8000-000000000001';

describe('optional marketplace publication button', () => {
  it.each(['PUBLICATION', 'VK_IMPORT', 'APPROVED_SUGGESTION'] as const)(
    'permits only the actual public target for %s',
    (purpose) => {
      expect(isMarketplacePublicationTarget('-10', { entityId: '-10', purpose })).toBe(true);
      expect(isMarketplacePublicationTarget('10', { entityId: '-10', purpose })).toBe(false);
      expect(isMarketplacePublicationTarget('-11', { entityId: '-10', purpose })).toBe(false);
      expect(isMarketplacePublicationTarget('-10', undefined)).toBe(false);
    },
  );

  it('preserves media, rich text and all authored rows, adds exactly one final row without mutating input', () => {
    const original: MaxSendMessageOptions = {
      textFormat: 'html',
      imagePayload: { token: 'fixture' },
      messageLink: { type: 'reply', mid: 'fixture-mid' },
      buttons: [
        [{ type: 'callback', text: 'Комментарии', payload: 'comments' }],
        [{ type: 'link', text: 'Мой сайт', url: 'https://example.com' }],
      ],
    };
    const snapshot = structuredClone(original);
    const result = appendMarketplacePublicationButton(original, url);
    expect(result.outcome).toBe('ADDED');
    expect(result.options).toEqual({
      ...snapshot,
      buttons: [...snapshot.buttons!, [{ type: 'link', text: 'Профиль на бирже', url }]],
    });
    expect(original).toEqual(snapshot);
    expect(appendMarketplacePublicationButton(result.options, `${url}#preview`).outcome).toBe(
      'DUPLICATE',
    );
  });

  it('keeps legacy single-button inputs', () => {
    const button = { type: 'link' as const, text: 'Заказать', url: 'https://example.com' };
    expect(appendMarketplacePublicationButton({ button }, url).options.buttons?.[0]).toEqual([
      button,
    ]);
  });

  it('omits the optional row when actual MAX layout, including full-width links, fills capacity', () => {
    const options: MaxSendMessageOptions = {
      buttons: Array.from({ length: 30 }, (_, i) => [
        { type: 'link', text: `Ссылка ${i}`, url: `https://example.com/${i}` },
      ]),
    };
    expect(appendMarketplacePublicationButton(options, url)).toEqual({
      options,
      outcome: 'KEYBOARD_FULL',
    });
    const splitRows: MaxSendMessageOptions = { buttons: [options.buttons!.flat()] };
    expect(appendMarketplacePublicationButton(splitRows, url).outcome).toBe('KEYBOARD_FULL');
  });

  it.each([
    'https://evil.test/profile',
    'http://max.ru/bot',
    'https://secret@max.ru/bot',
    'javascript:alert(1)',
  ])('rejects noncanonical profile target %s', (badUrl) => {
    const options = {};
    expect(appendMarketplacePublicationButton(options, badUrl)).toEqual({
      options,
      outcome: 'INVALID_LINK',
    });
  });
});
