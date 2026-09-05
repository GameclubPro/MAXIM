import { chatSettingsSchema } from '@maxim/contracts';
import {
  buildPrivateDuplicateFlowSettings,
  isPrivateDuplicateFlowSettingKey,
  normalizePrivateDuplicateFlowSettings,
  resolvePrivateDuplicateAllowedCount,
  resolvePrivateDuplicateAllowedCountMax,
  resolvePrivateDuplicateSharedWindowSec,
} from './private-control-duplicate-flow';

function createSettings(overrides: Partial<ReturnType<typeof chatSettingsSchema.parse>> = {}) {
  return chatSettingsSchema.parse({
    ...overrides,
  });
}

describe('private control duplicate flow', () => {
  it('detects settings that require duplicate flow normalization', () => {
    expect(isPrivateDuplicateFlowSettingKey('duplicateWarnMaxCount')).toBe(true);
    expect(isPrivateDuplicateFlowSettingKey('duplicateBotMessageEnabled')).toBe(true);
    expect(isPrivateDuplicateFlowSettingKey('antiDuplicateEnabled')).toBe(false);
    expect(isPrivateDuplicateFlowSettingKey('linkPolicy')).toBe(false);
  });

  it('resolves the shared duplicate window from the first enabled sanction step', () => {
    expect(
      resolvePrivateDuplicateSharedWindowSec(
        createSettings({
          duplicateWarnEnabled: true,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: true,
          duplicateWarnWindowSec: 43_200,
          duplicateMuteWindowSec: 86_400,
          duplicateBanWindowSec: 172_800,
        }),
      ),
    ).toBe(43_200);

    expect(
      resolvePrivateDuplicateSharedWindowSec(
        createSettings({
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: true,
          duplicateWarnWindowSec: 43_200,
          duplicateMuteWindowSec: 86_400,
          duplicateBanWindowSec: 172_800,
        }),
      ),
    ).toBe(86_400);

    expect(
      resolvePrivateDuplicateSharedWindowSec(
        createSettings({
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: true,
          duplicateWarnWindowSec: 43_200,
          duplicateMuteWindowSec: 86_400,
          duplicateBanWindowSec: 172_800,
        }),
      ),
    ).toBe(172_800);

    expect(
      resolvePrivateDuplicateSharedWindowSec(
        createSettings({
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: false,
          duplicateWarnWindowSec: 43_200,
          duplicateMuteWindowSec: 86_400,
          duplicateBanWindowSec: 172_800,
        }),
      ),
    ).toBe(43_200);
  });

  it('resolves allowed duplicate count from the first enabled threshold', () => {
    expect(
      resolvePrivateDuplicateAllowedCount(
        createSettings({
          duplicateBotMessageEnabled: false,
          duplicateWarnEnabled: true,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: true,
          duplicateWarnMaxCount: 4,
          duplicateMuteMaxCount: 8,
          duplicateBanMaxCount: 12,
        }),
      ),
    ).toBe(3);

    expect(
      resolvePrivateDuplicateAllowedCount(
        createSettings({
          duplicateBotMessageEnabled: true,
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: true,
          duplicateWarnMaxCount: 4,
          duplicateMuteMaxCount: 8,
          duplicateBanMaxCount: 12,
        }),
      ),
    ).toBe(6);

    expect(
      resolvePrivateDuplicateAllowedCount(
        createSettings({
          duplicateBotMessageEnabled: true,
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: false,
          duplicateWarnMaxCount: 1,
          duplicateMuteMaxCount: 8,
          duplicateBanMaxCount: 12,
        }),
      ),
    ).toBe(0);
  });

  it('caps allowed duplicate count by the remaining threshold budget', () => {
    expect(
      resolvePrivateDuplicateAllowedCountMax(
        createSettings({
          duplicateBotMessageEnabled: true,
          duplicateWarnEnabled: true,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: true,
        }),
      ),
    ).toBe(16);

    expect(
      resolvePrivateDuplicateAllowedCount(
        createSettings({
          duplicateBotMessageEnabled: false,
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: true,
          duplicateWarnMaxCount: 2,
          duplicateMuteMaxCount: 3,
          duplicateBanMaxCount: 20,
        }),
      ),
    ).toBe(19);
  });

  it.each([
    ['no actions', false, false, false, false, 19, [20, 20, 20]],
    ['no actions', true, false, false, false, 18, [20, 20, 20]],
    ['WARN only', false, true, false, false, 19, [20, 20, 20]],
    ['WARN only', true, true, false, false, 18, [20, 20, 20]],
    ['WARN and BAN', false, true, false, true, 18, [19, 20, 20]],
    ['WARN and BAN', true, true, false, true, 17, [19, 20, 20]],
    ['MUTE and BAN', false, false, true, true, 18, [19, 19, 20]],
    ['MUTE and BAN', true, false, true, true, 17, [19, 19, 20]],
    ['full ladder', false, true, true, true, 17, [18, 19, 20]],
    ['full ladder', true, true, true, true, 16, [18, 19, 20]],
  ] as const)(
    '%s preserves its maximum allowance with bot message %s',
    (
      _name,
      duplicateBotMessageEnabled,
      duplicateWarnEnabled,
      duplicateMuteEnabled,
      duplicateBanEnabled,
      expectedMax,
      expectedThresholds,
    ) => {
      const stages = {
        duplicateBotMessageEnabled,
        duplicateWarnEnabled,
        duplicateMuteEnabled,
        duplicateBanEnabled,
      };
      expect(resolvePrivateDuplicateAllowedCountMax(stages)).toBe(expectedMax);

      const built = buildPrivateDuplicateFlowSettings({
        ...stages,
        allowedCount: 99,
        windowSec: 7_200,
      });
      expect([
        built.duplicateWarnMaxCount,
        built.duplicateMuteMaxCount,
        built.duplicateBanMaxCount,
      ]).toEqual(expectedThresholds);
      expect(resolvePrivateDuplicateAllowedCount({ ...stages, ...built })).toBe(expectedMax);
    },
  );

  it('builds synchronized thresholds and windows from a compact flow state', () => {
    expect(
      buildPrivateDuplicateFlowSettings({
        duplicateBotMessageEnabled: true,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        allowedCount: 5.6,
        windowSec: 7_200.2,
      }),
    ).toEqual({
      duplicateWarnWindowSec: 7_200,
      duplicateMuteWindowSec: 7_200,
      duplicateBanWindowSec: 7_200,
      duplicateWarnMaxCount: 8,
      duplicateMuteMaxCount: 9,
      duplicateBanMaxCount: 10,
    });
  });

  it('clamps flow input values without changing step ordering semantics', () => {
    expect(
      buildPrivateDuplicateFlowSettings({
        duplicateBotMessageEnabled: false,
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: false,
        duplicateBanEnabled: true,
        allowedCount: 99,
        windowSec: 100,
      }),
    ).toEqual({
      duplicateWarnWindowSec: 3_600,
      duplicateMuteWindowSec: 3_600,
      duplicateBanWindowSec: 3_600,
      duplicateWarnMaxCount: 20,
      duplicateMuteMaxCount: 20,
      duplicateBanMaxCount: 20,
    });

    expect(
      buildPrivateDuplicateFlowSettings({
        duplicateBotMessageEnabled: false,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: false,
        duplicateBanEnabled: true,
        allowedCount: -10,
        windowSec: 999_999,
      }),
    ).toEqual({
      duplicateWarnWindowSec: 604_800,
      duplicateMuteWindowSec: 604_800,
      duplicateBanWindowSec: 604_800,
      duplicateWarnMaxCount: 1,
      duplicateMuteMaxCount: 2,
      duplicateBanMaxCount: 2,
    });
  });

  it('normalizes a full chat settings object from the current first threshold and window', () => {
    const settings = createSettings({
      duplicateBotMessageEnabled: true,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateWarnWindowSec: 43_200,
      duplicateMuteWindowSec: 86_400,
      duplicateBanWindowSec: 172_800,
      duplicateWarnMaxCount: 4,
      duplicateMuteMaxCount: 8,
      duplicateBanMaxCount: 12,
    });

    expect(normalizePrivateDuplicateFlowSettings(settings)).toEqual(
      expect.objectContaining({
        duplicateWarnWindowSec: 86_400,
        duplicateMuteWindowSec: 86_400,
        duplicateBanWindowSec: 86_400,
        duplicateWarnMaxCount: 8,
        duplicateMuteMaxCount: 8,
        duplicateBanMaxCount: 9,
      }),
    );
  });

  it('round-trips a WARN-only threshold at the contract maximum', () => {
    const settings = createSettings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      duplicateWarnWindowSec: 43_200,
      duplicateMuteWindowSec: 43_200,
      duplicateBanWindowSec: 43_200,
      duplicateWarnMaxCount: 20,
      duplicateMuteMaxCount: 20,
      duplicateBanMaxCount: 20,
    });

    expect(resolvePrivateDuplicateAllowedCount(settings)).toBe(19);
    expect(normalizePrivateDuplicateFlowSettings(settings)).toEqual(settings);
  });
});
