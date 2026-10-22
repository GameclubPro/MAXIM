import { describe, expect, it } from 'vitest';
import * as fields from '../src/bot-speech-fields.js';
import * as speechCore from '../src/bot-speech-core.js';
import * as speech from '../src/bot-speech.js';
import * as compatibility from '../src/core.js';
import * as root from '../src/index.js';
import { botSpeechMediaSchema, chatSettingsFieldsSchema } from '../src/settings-field-schemas.js';

describe('canonical bot speech field contracts', () => {
  it('retains identical field bindings through every existing compatibility entry', () => {
    for (const name of [
      'BOT_SPEECH_STYLE_VALUES',
      'botSpeechStyleSchema',
      'BOT_SPEECH_EDITABLE_FIELD_KEYS',
    ] as const) {
      for (const entry of [speechCore, speech, compatibility, root]) {
        expect(entry[name], name).toBe(fields[name]);
      }
    }
    expect(speech.updateBotSpeechStyleRequestSchema.shape.botSpeechStyle).toBe(
      fields.botSpeechStyleSchema,
    );
    expect(speech.updateBotSpeechStyleResponseSchema.shape.botSpeechStyle).toBe(
      fields.botSpeechStyleSchema,
    );
  });

  it('preserves the closed style catalog and rejects invalid values', () => {
    expect(fields.BOT_SPEECH_STYLE_VALUES).toEqual(['ROBOT', 'FRIENDLY', 'POLICE', 'IRONIC']);
    for (const style of fields.BOT_SPEECH_STYLE_VALUES) {
      expect(fields.botSpeechStyleSchema.parse(style)).toBe(style);
    }
    for (const invalid of [undefined, null, '', 'CUSTOM', 'friendly', ' FRIENDLY ']) {
      expect(fields.botSpeechStyleSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('keeps field defaults and dedicated style mutation requirements independent', () => {
    const style = chatSettingsFieldsSchema.shape.botSpeechStyle;
    expect(style.unwrap().unwrap()).toBe(fields.botSpeechStyleSchema);
    expect(style.parse(undefined)).toBe('FRIENDLY');
    expect(style.parse(null)).toBeNull();
    expect(speech.updateBotSpeechStyleRequestSchema.safeParse({}).success).toBe(false);
    expect(
      speech.updateBotSpeechStyleRequestSchema.safeParse({ botSpeechStyle: null }).success,
    ).toBe(false);
  });

  it('preserves all editable media keys while rejecting unrelated settings keys', () => {
    expect(fields.BOT_SPEECH_EDITABLE_FIELD_KEYS).toHaveLength(17);
    for (const key of fields.BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(botSpeechMediaSchema.parse({ [key]: {} })).toEqual({
        [key]: { base64: '', mimeType: '', fileName: '' },
      });
    }
    for (const key of ['botSpeechStyle', 'nightModeEnabled', 'unknownBotMessageText']) {
      expect(botSpeechMediaSchema.safeParse({ [key]: {} }).success).toBe(false);
    }
  });
});
