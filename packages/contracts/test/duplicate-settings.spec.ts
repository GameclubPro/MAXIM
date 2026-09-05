import { describe, expect, it } from 'vitest';
import {
  buildDuplicateFlowThresholds,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  resolveDuplicateTextRuleSubjects,
} from '@maxim/contracts/settings';

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
