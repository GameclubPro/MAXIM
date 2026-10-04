import { describe, expect, it } from 'vitest';
import {
  buildDuplicateRulesTextItems,
  chatSettingsSchema,
  duplicatePhotoModerationModeSchema,
} from '../src/settings.js';
import { buildDuplicateRulesTextItems as rootFormatter } from '../src/index.js';
import cases from './fixtures/duplicate-rules.json';

describe('duplicate rules presentation', () => {
  it.each(cases)('$name', (fixture) => {
    const settings = chatSettingsSchema.parse(fixture.settings);
    const before = structuredClone(settings);
    expect(
      buildDuplicateRulesTextItems(
        settings,
        duplicatePhotoModerationModeSchema.parse(fixture.photoMode),
      ),
    ).toEqual(fixture.expected);
    expect(settings).toEqual(before);
  });

  it('keeps root and settings exports compatible without promising unknown photo authority', () => {
    expect(rootFormatter).toBe(buildDuplicateRulesTextItems);
    expect(rootFormatter(chatSettingsSchema.parse({ antiDuplicateEnabled: true }))).not.toContain(
      expect.stringContaining('картинки'),
    );
  });
});
