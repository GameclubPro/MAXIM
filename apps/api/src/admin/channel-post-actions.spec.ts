import type { MaxMessageButton } from '../max/max-client.service';
import { buildChannelPostActionRows } from '../common/channel-post-actions';

function link(text: string, url: string): MaxMessageButton {
  return { type: 'link', text, url };
}

describe('buildChannelPostActionRows', () => {
  it('keeps managed channel actions first in their product order', () => {
    expect(
      buildChannelPostActionRows({
        commentsButton: link('Comments', 'https://max.ru/comments'),
        suggestButton: link('Suggest', 'https://max.ru/suggest'),
        ctaButton: link('Advertise', 'https://example.test/ads'),
        customButtonRows: [
          [
            link('First custom', 'https://example.test/first'),
            link('Second custom', 'https://example.test/second'),
          ],
        ],
      }),
    ).toEqual([
      [link('Comments', 'https://max.ru/comments')],
      [link('Suggest', 'https://max.ru/suggest')],
      [link('Advertise', 'https://example.test/ads')],
      [link('First custom', 'https://example.test/first')],
      [link('Second custom', 'https://example.test/second')],
    ]);
  });

  it('removes a custom link already represented by the channel CTA', () => {
    expect(
      buildChannelPostActionRows({
        ctaButton: link('Advertise', 'https://example.test/ads#contact'),
        customButtonRows: [
          [link('Duplicate', 'https://example.test/ads'), link('Details', 'https://example.test/info')],
        ],
      }),
    ).toEqual([
      [link('Advertise', 'https://example.test/ads#contact')],
      [link('Details', 'https://example.test/info')],
    ]);
  });

  it('does not collapse callback buttons without a stable link identity', () => {
    const callback: MaxMessageButton = { type: 'callback', text: 'Vote', payload: 'vote:1' };
    expect(buildChannelPostActionRows({ customButtonRows: [[callback, callback]] })).toEqual([
      [callback],
      [callback],
    ]);
  });
});
