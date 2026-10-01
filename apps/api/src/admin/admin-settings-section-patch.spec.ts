import { chatSettingsSchema } from '@maxim/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { buildSettingsSectionPatch } from './admin-settings-section-patch';

const revision = '2026-10-01T10:00:00.000Z';
const current = chatSettingsSchema.parse({
  settingsRevision: revision,
  antiSpamEnabled: true,
  profanityBotMessageText: 'Отдельный текст',
});
const patch = (
  changes: Record<string, unknown>,
  section = 'commercialFilter',
  expectedRevision = revision,
) => ({ section, expectedRevision, changes });

describe('section settings patches', () => {
  it('merges only the requested section and retains the original revision', () => {
    const next = buildSettingsSectionPatch(current, patch({ commercialAdsDeleteThreshold: 70 }));
    expect(next.commercialAdsDeleteThreshold).toBe(70);
    expect(next.antiSpamEnabled).toBe(true);
    expect(next.profanityBotMessageText).toBe('Отдельный текст');
    expect(next.settingsRevision).toBe(revision);
    expect(next).not.toHaveProperty('stopWordsPolicy');
  });
  it('rejects stale GET revisions before server merge', () => {
    expect(() =>
      buildSettingsSectionPatch(current, patch({}, 'commercialFilter', '2026-10-01T09:00:00.000Z')),
    ).toThrow(ConflictException);
  });
  it('rejects another section, metadata and independent stop-list ownership', () => {
    for (const changes of [
      { antiSpamEnabled: false },
      { settingsRevision: revision },
      { stopWordsPolicy: {} },
    ]) {
      expect(() => buildSettingsSectionPatch(current, patch(changes))).toThrow(BadRequestException);
    }
    expect(() => buildSettingsSectionPatch(current, patch({}, 'stopWords'))).toThrow(
      BadRequestException,
    );
  });
  it('limits template media to the requested section and preserves other media', () => {
    const media = { mimeType: 'image/png', base64: 'YQ==', fileName: 'image.png' };
    const settings = {
      ...current,
      botSpeechMedia: { profanityBotMessageText: media, textFiltersBotMessageText: media },
    };
    const next = buildSettingsSectionPatch(settings, patch({ botSpeechMedia: {} }));
    expect(next.botSpeechMedia).toEqual({ profanityBotMessageText: media });
    expect(() =>
      buildSettingsSectionPatch(
        settings,
        patch({ botSpeechMedia: { profanityBotMessageText: media } }),
      ),
    ).toThrow(BadRequestException);
  });
});
