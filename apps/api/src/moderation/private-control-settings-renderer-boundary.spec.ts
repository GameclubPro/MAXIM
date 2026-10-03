import { chatSettingsSchema } from '@maxim/contracts';

jest.mock('@nestjs/common', () => {
  throw new Error('Private settings rendering must not load Nest or runtime services');
});

import { buildPrivateCallbackPayload } from './private-control-callback-buttons';
import { buildSectionActionRows, findSettingMatches } from './private-control-settings-renderer';

describe('private settings renderer isolation', () => {
  it('renders frozen input without runtime services or shared mutable rows', () => {
    const settings = Object.freeze(chatSettingsSchema.parse({}));
    const first = buildSectionActionRows('links', settings, 'basic');
    const expected = structuredClone(first);
    first[0]![0]!.text = 'caller override';
    first.push([]);
    expect(buildSectionActionRows('links', settings, 'basic')).toEqual(expected);
  });

  it('returns independent search results for each caller', () => {
    const first = findSettingMatches('мут');
    const expected = structuredClone(first);
    first[0]!.label = 'caller override';
    first.length = 0;
    expect(findSettingMatches('мут')).toEqual(expected);
  });

  it('preserves trimming and omission in persisted callback arguments', () => {
    expect(buildPrivateCallbackPayload('search_jump', ' links ', '', '  ', ' linkPolicy ')).toBe(
      'pc2|search_jump|links|linkPolicy',
    );
  });
});
