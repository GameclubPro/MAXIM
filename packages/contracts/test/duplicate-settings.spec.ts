import { describe, expect, it } from 'vitest';
import {
  buildDuplicateFlowThresholds,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  resolveDuplicateTextRuleSubjects,
  resolveDuplicateIntervalWindowSec,
  DUPLICATE_WINDOW_MAX_SEC,
  chatSettingsSchema,
} from '@maxim/contracts/settings';

describe('bounded duplicate window', () => {
  it.each(['duplicateWarnWindowSec', 'duplicateMuteWindowSec', 'duplicateBanWindowSec'])(
    'rejects new %s writes beyond 48 hours',
    (key) => {
      expect(chatSettingsSchema.safeParse({ [key]: DUPLICATE_WINDOW_MAX_SEC }).success).toBe(true);
      expect(chatSettingsSchema.safeParse({ [key]: DUPLICATE_WINDOW_MAX_SEC + 1 }).success).toBe(
        false,
      );
    },
  );

  it.each([
    { duplicateWarnEnabled: true },
    { duplicateMuteEnabled: true },
    { duplicateBanEnabled: true },
    {},
  ])('caps the effective window of legacy records for every first reaction', (stage) => {
    expect(
      resolveDuplicateIntervalWindowSec({
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: false,
        duplicateBanEnabled: false,
        duplicateWarnWindowSec: 604800,
        duplicateMuteWindowSec: 604800,
        duplicateBanWindowSec: 604800,
        ...stage,
      }),
    ).toBe(DUPLICATE_WINDOW_MAX_SEC);
  });
});

describe('duplicate flow thresholds', () => {
  it('keeps a WARN-only threshold at 20 while saturating hidden thresholds', () => {
    const stages = {
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    };

    expect(resolveDuplicateFlowAllowedCountMax(stages)).toBe(19);
    const thresholds = buildDuplicateFlowThresholds({ ...stages, allowedCount: 19 });
    expect(thresholds).toEqual({
      duplicateWarnMaxCount: 20,
      duplicateMuteMaxCount: 20,
      duplicateBanMaxCount: 20,
    });
    expect(resolveDuplicateFlowAllowedCount({ ...stages, ...thresholds })).toBe(19);
  });

  it('keeps the complete bot-message ladder within threshold 20', () => {
    const stages = {
      duplicateBotMessageEnabled: true,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    };

    expect(resolveDuplicateFlowAllowedCountMax(stages)).toBe(16);
    expect(buildDuplicateFlowThresholds({ ...stages, allowedCount: 99 })).toEqual({
      duplicateWarnMaxCount: 18,
      duplicateMuteMaxCount: 19,
      duplicateBanMaxCount: 20,
    });
  });
});

describe('duplicate text rule subjects', () => {
  it.each([
    [
      {
        duplicateDetectionPreset: 'STANDARD' as const,
        duplicateIgnoreLinksEnabled: true,
        duplicateIgnorePhonesEnabled: true,
        duplicateNearMatchEnabled: true,
      },
      ['одинаковые сообщения'],
    ],
    [
      {
        duplicateDetectionPreset: 'STRICT' as const,
        duplicateIgnoreLinksEnabled: false,
        duplicateIgnorePhonesEnabled: false,
        duplicateNearMatchEnabled: false,
      },
      ['одинаковые и похожие сообщения'],
    ],
    [
      {
        duplicateDetectionPreset: 'CUSTOM' as const,
        duplicateIgnoreLinksEnabled: true,
        duplicateIgnorePhonesEnabled: true,
        duplicateNearMatchEnabled: true,
      },
      ['одинаковые и похожие сообщения', 'одни и те же ссылки', 'одни и те же номера телефонов'],
    ],
  ])('describes the effective matching scope for %#', (settings, expected) => {
    expect(resolveDuplicateTextRuleSubjects(settings)).toEqual(expected);
  });
});
