import { buildPrivateRulesScreenTextPreview } from './private-control-rules-preview';

describe('private chat rules preview', () => {
  it('keeps markdown rules formatted in the private screen', () => {
    expect(buildPrivateRulesScreenTextPreview('**Правила**', 'markdown')).toBe('**Правила**');
  });

  it('escapes markdown punctuation in plain rules', () => {
    expect(buildPrivateRulesScreenTextPreview('**буквально**\n# текст', 'plain')).toBe(
      '\\*\\*буквально\\*\\*\n\\# текст',
    );
  });
});
