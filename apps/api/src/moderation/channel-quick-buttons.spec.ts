import { extractChannelQuickButtons } from './channel-quick-buttons';
import {
  parseChannelAutoPostListedMessage,
  resolveChannelAutoPostMessageText,
} from './channel-auto-post-runtime';

describe('channel quick buttons', () => {
  it('removes multiple quoted templates in order without altering other whitespace', () => {
    expect(
      extractChannelQuickButtons(
        'Post\n"Read" = "https://example.com/a?x=1&y=2"\n"Join"="https://max.ru/channel"',
        [],
      ),
    ).toEqual({
      text: 'Post\n\n',
      textFormat: 'html',
      quickButtons: {
        sourceMarkup: [],
        sourceText:
          'Post\n"Read" = "https://example.com/a?x=1&y=2"\n"Join"="https://max.ru/channel"',
        buttons: [
          [{ type: 'link', text: 'Read', url: 'https://example.com/a?x=1&y=2' }],
          [{ type: 'link', text: 'Join', url: 'https://max.ru/channel' }],
        ],
      },
    });
  });

  it('maps markup before, across and after removals using UTF-16 offsets', () => {
    const template = '"Read"="https://example.com"';
    const text = `\u{1f525}Before ${template} After`;
    expect(
      extractChannelQuickButtons(text, [
        { type: 'strong', from: 2, length: text.length - 2, url: null, userLink: null },
        { type: 'underline', from: 2, length: 6, url: null, userLink: null },
        {
          type: 'link',
          from: 9,
          length: template.length,
          url: 'https://example.com/',
          userLink: null,
        },
        { type: 'emphasized', from: text.indexOf('After'), length: 5, url: null, userLink: null },
      ])?.text,
    ).toBe('\u{1f525}<strong><u>Before</u>&nbsp;&nbsp;<em>After</em></strong>');
  });

  it('escapes literal HTML while retaining real links and mentions', () => {
    const text = '<Title> "Read"="https://example.com" Alice';
    expect(
      extractChannelQuickButtons(text, [
        {
          type: 'user_mention',
          from: text.indexOf('Alice'),
          length: 5,
          url: null,
          userLink: 'max://user/123',
        },
      ])?.text,
    ).toBe('&lt;Title&gt;&nbsp;&nbsp;<a href="max://user/123">Alice</a>');
  });

  it.each([
    'Post without a template',
    '"Read"="javascript:alert(1)"',
    '"Read"="https://user:password@example.com"',
    '"Read"="https://example.com/a b"',
    '"Read"="https://max.ru/bot?start=pmh-secret"',
    '"Read"="https://max.ru/bot?start=pm2_secret"',
    '""="https://example.com"',
    `"${'x'.repeat(33)}"="https://example.com"`,
    '"Read\nmore"="https://example.com"',
    '"Read"=https://example.com',
  ])('leaves invalid or unsafe templates untouched: %s', (text) => {
    expect(extractChannelQuickButtons(text, [])).toBeNull();
  });

  it('leaves invalid templates alongside converted valid ones', () => {
    expect(
      extractChannelQuickButtons('"Bad"="javascript:bad" "Read"="https://example.com"', [])?.text,
    ).toBe('&quot;Bad&quot;=&quot;javascript:bad&quot; ');
  });

  it('does not partially consume an oversized keyboard', () => {
    expect(
      extractChannelQuickButtons(
        Array.from({ length: 21 }, (_, i) => `"${i}"="https://example.com/${i}"`).join('\n'),
        [],
      ),
    ).toBeNull();
  });

  it('is opt-in for both webhook and polling text resolution', () => {
    const text = 'Post "Read"="https://example.com"';
    const message = { timestamp: 1_800_000_000_000, body: { mid: 'mid-1', text } };
    expect(resolveChannelAutoPostMessageText(message, null)).toEqual({ text, textFormat: null });
    expect(parseChannelAutoPostListedMessage(message)?.quickButtons).toBeUndefined();
    expect(parseChannelAutoPostListedMessage(message, 'channel-1', true)?.text).toBe('Post ');
    expect(
      resolveChannelAutoPostMessageText(message, null, true).quickButtons?.buttons,
    ).toHaveLength(1);
  });

  it('reads forwarded body markup and rejects native channel comments', () => {
    const text = 'Post "Read"="https://example.com"';
    const message = {
      timestamp: 1_800_000_000_000,
      body: { mid: 'mid-1', text: '' },
      link: {
        type: 'forward',
        message: { body: { text, markup: [{ type: 'strong', from: 0, length: 4 }] } },
      },
    };
    expect(resolveChannelAutoPostMessageText(message, null, true).text).toBe(
      '<strong>Post</strong> ',
    );
    expect(
      parseChannelAutoPostListedMessage(
        { ...message, recipient: { post_id: 'parent' } },
        'channel-1',
        true,
      ),
    ).toBeNull();
  });
});
