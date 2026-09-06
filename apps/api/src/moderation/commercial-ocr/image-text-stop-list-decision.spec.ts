import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialOcrPass } from './commercial-ocr-decision-policy';
import {
  evaluateImageTextStopListDecision,
  IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE,
  shouldConfirmImageTextStopListPass,
  type ImageTextStopListSettings,
} from './image-text-stop-list-decision';

const settings = (overrides: Partial<ImageTextStopListSettings> = {}): ImageTextStopListSettings =>
  ({
    messageLimitsBlockedWords: [],
    messageLimitsBlockedDomains: [],
    ...overrides,
  }) as Pick<ChatSettings, 'messageLimitsBlockedWords' | 'messageLimitsBlockedDomains'>;

function pass(
  text: string,
  confidencePermille = IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE,
  status: CommercialOcrPass['status'] = 'recognized',
): CommercialOcrPass {
  return {
    status,
    text,
    confidencePermille,
    words:
      status === 'recognized'
        ? [...text.matchAll(/\S+/gu)].map((match) => ({
            text: match[0],
            start: match.index ?? 0,
            end: (match.index ?? 0) + match[0].length,
            confidencePermille,
          }))
        : [],
  };
}

describe('evaluateImageTextStopListDecision', () => {
  it('requests confirmation only for a high-confidence primary stop-list candidate', () => {
    const currentSettings = settings({ messageLimitsBlockedWords: ['казино'] });

    expect(shouldConfirmImageTextStopListPass(pass('казино', 900), currentSettings)).toBe(true);
    expect(shouldConfirmImageTextStopListPass(pass('казино', 899), currentSettings)).toBe(false);
    expect(shouldConfirmImageTextStopListPass(pass('обычный текст', 950), currentSettings)).toBe(
      false,
    );
    expect(shouldConfirmImageTextStopListPass(pass('', 950, 'no_text'), currentSettings)).toBe(
      false,
    );
  });

  it('rejects a low-confidence matched token even when the page aggregate is high', () => {
    const primary = pass('обычный текст казино', 980);
    const words = primary.words!.map((word) =>
      word.text === 'казино' ? { ...word, confidencePermille: 100 } : word,
    );

    expect(
      shouldConfirmImageTextStopListPass(
        { ...primary, words },
        settings({ messageLimitsBlockedWords: ['казино'] }),
      ),
    ).toBe(false);
  });

  it('accepts a stop word only when both high-confidence passes resolve the same canonical value', () => {
    const result = evaluateImageTextStopListDecision({
      settings: settings({ messageLimitsBlockedWords: ['ставка'] }),
      images: [
        {
          imageIndex: 2,
          primary: pass('Лучшие ставки сегодня', 940),
          confirmation: pass('СТАВКА без риска', 915),
        },
      ],
    });

    expect(result).toEqual({
      kind: 'match',
      ruleCode: 'MESSAGE_BLOCKED_WORD',
      value: 'ставка',
      imageIndex: 2,
      primaryConfidencePermille: 940,
      confirmationConfidencePermille: 915,
    });
    expect(JSON.stringify(result)).not.toContain('Лучшие');
    expect(JSON.stringify(result)).not.toContain('риска');
  });

  it('accepts a blocked domain and preserves the domain allowlist override', () => {
    const input = {
      settings: settings({ messageLimitsBlockedDomains: ['casino.example'] }),
      images: [
        {
          imageIndex: 0,
          primary: pass('https://offers.casino.example/win', 970),
          confirmation: pass('casino.example', 950),
        },
      ],
    } as const;

    expect(evaluateImageTextStopListDecision(input)).toMatchObject({
      kind: 'match',
      ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
      value: 'casino.example',
      imageIndex: 0,
    });
    expect(evaluateImageTextStopListDecision({ ...input, isLinkAllowlisted: () => true })).toEqual({
      kind: 'no_action',
    });
  });

  it('consults the allowlist only for links that match a blocked domain', () => {
    const isLinkAllowlisted = jest.fn(() => false);

    expect(
      evaluateImageTextStopListDecision({
        settings: settings({ messageLimitsBlockedDomains: ['casino.example'] }),
        images: [
          {
            imageIndex: 0,
            primary: pass('https://neutral.example https://casino.example/offer', 960),
            confirmation: pass('https://other.example https://casino.example/offer', 950),
          },
        ],
        isLinkAllowlisted,
      }),
    ).toMatchObject({ kind: 'match', ruleCode: 'MESSAGE_BLOCKED_DOMAIN' });
    expect(isLinkAllowlisted).toHaveBeenCalledTimes(2);
    expect(isLinkAllowlisted).toHaveBeenNthCalledWith(1, 'https://casino.example/offer');
    expect(isLinkAllowlisted).toHaveBeenNthCalledWith(2, 'https://casino.example/offer');
  });

  it('agrees on a parent blocked domain across differently specific OCR passes', () => {
    expect(
      evaluateImageTextStopListDecision({
        settings: settings({
          messageLimitsBlockedDomains: ['offers.casino.example', 'casino.example'],
        }),
        images: [
          {
            imageIndex: 0,
            primary: pass('offers.casino.example', 960),
            confirmation: pass('casino.example', 950),
          },
        ],
      }),
    ).toMatchObject({
      kind: 'match',
      ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
      value: 'casino.example',
    });
  });

  it.each([
    {
      label: 'primary confidence below the gate',
      primary: pass('казино', IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE - 1),
      confirmation: pass('казино', 950),
    },
    {
      label: 'confirmation confidence below the gate',
      primary: pass('казино', 950),
      confirmation: pass('казино', IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE - 1),
    },
    {
      label: 'missing confirmation',
      primary: pass('казино', 950),
      confirmation: null,
    },
    {
      label: 'non-recognized confirmation',
      primary: pass('казино', 950),
      confirmation: pass('', 950, 'no_text'),
    },
  ])('returns no action for $label', ({ primary, confirmation }) => {
    expect(
      evaluateImageTextStopListDecision({
        settings: settings({ messageLimitsBlockedWords: ['казино'] }),
        images: [{ imageIndex: 0, primary, confirmation }],
      }),
    ).toEqual({ kind: 'no_action' });
  });

  it('uses a stable domain when unrelated word candidates differ between passes', () => {
    expect(
      evaluateImageTextStopListDecision({
        settings: settings({
          messageLimitsBlockedWords: ['казино', 'ставки'],
          messageLimitsBlockedDomains: ['casino.example'],
        }),
        images: [
          {
            imageIndex: 0,
            primary: pass('казино casino.example', 960),
            confirmation: pass('ставки casino.example', 960),
          },
        ],
      }),
    ).toMatchObject({
      kind: 'match',
      ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
      value: 'casino.example',
    });
  });

  it('rejects passes with no common canonical stop-list value', () => {
    expect(
      evaluateImageTextStopListDecision({
        settings: settings({ messageLimitsBlockedWords: ['казино', 'ставки'] }),
        images: [
          {
            imageIndex: 0,
            primary: pass('казино', 960),
            confirmation: pass('ставки', 960),
          },
        ],
      }),
    ).toEqual({ kind: 'no_action' });
  });

  it('skips an unconfirmed image and returns the first confirmed image match', () => {
    expect(
      evaluateImageTextStopListDecision({
        settings: settings({ messageLimitsBlockedWords: ['казино'] }),
        images: [
          {
            imageIndex: 0,
            primary: pass('казино', 950),
            confirmation: pass('обычный текст', 950),
          },
          {
            imageIndex: 1,
            primary: pass('к а з и н о', 950),
            confirmation: pass('казино', 950),
          },
        ],
      }),
    ).toMatchObject({ kind: 'match', ruleCode: 'MESSAGE_BLOCKED_WORD', imageIndex: 1 });
  });
});
