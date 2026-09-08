import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import {
  buildDuplicateFlowSettings,
  normalizeDuplicateFlowSettings,
  resolveDuplicateAllowedCount,
  resolveDuplicateAllowedCountMax,
} from '../src/pages/settings/settings-duplicate-flow';
import { buildDuplicateTextActionPreview } from '../src/pages/settings/settings-duplicate-action-preview';

const flowCases = [
  {
    name: 'no actions',
    actions: {
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    },
    maxWithoutBotMessage: 19,
    maxWithBotMessage: 18,
    thresholds: [20, 20, 20],
  },
  {
    name: 'WARN only',
    actions: {
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    },
    maxWithoutBotMessage: 19,
    maxWithBotMessage: 18,
    thresholds: [20, 20, 20],
  },
  {
    name: 'WARN and BAN',
    actions: {
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: true,
    },
    maxWithoutBotMessage: 18,
    maxWithBotMessage: 17,
    thresholds: [19, 20, 20],
  },
  {
    name: 'MUTE and BAN',
    actions: {
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    },
    maxWithoutBotMessage: 18,
    maxWithBotMessage: 17,
    thresholds: [19, 19, 20],
  },
  {
    name: 'full ladder',
    actions: {
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    },
    maxWithoutBotMessage: 17,
    maxWithBotMessage: 16,
    thresholds: [18, 19, 20],
  },
] as const;

for (const flowCase of flowCases) {
  for (const duplicateBotMessageEnabled of [false, true]) {
    const expectedMax = duplicateBotMessageEnabled
      ? flowCase.maxWithBotMessage
      : flowCase.maxWithoutBotMessage;

    test(`${flowCase.name} keeps the maximum representable allowance with bot message ${duplicateBotMessageEnabled ? 'on' : 'off'}`, () => {
      const stages = {
        duplicateBotMessageEnabled,
        ...flowCase.actions,
      };
      assert.equal(resolveDuplicateAllowedCountMax(stages), expectedMax);

      const built = buildDuplicateFlowSettings({
        ...stages,
        allowedCount: 99,
        windowSec: 7_200,
      });
      assert.deepEqual(
        [built.duplicateWarnMaxCount, built.duplicateMuteMaxCount, built.duplicateBanMaxCount],
        flowCase.thresholds,
      );
      assert.equal(resolveDuplicateAllowedCount({ ...stages, ...built }), expectedMax);
    });
  }
}

test('WARN-only threshold 20 survives miniapp normalization', () => {
  const settings = chatSettingsSchema.parse({
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

  assert.equal(resolveDuplicateAllowedCount(settings), 19);
  assert.deepEqual(normalizeDuplicateFlowSettings(settings), settings);
});

test('duplicate preview separates the original, allowed repeats and enabled sanctions', () => {
  assert.deepEqual(
    buildDuplicateTextActionPreview(
      {
        duplicateBotMessageEnabled: true,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateMuteDurationHours: 6,
      },
      1,
    ),
    [
      { label: 'Первое сообщение', action: 'Остаётся в чате' },
      { label: 'Дубль №1', action: 'Остаётся в чате' },
      { label: 'Дубль №2', action: 'Удаление и объяснение' },
      { label: 'Дубль №3', action: 'Удаление и предупреждение' },
      { label: 'Дубль №4', action: 'Удаление и ограничение на 6 ч' },
      { label: 'Дубль №5 и далее', action: 'Удаление и блокировка навсегда' },
    ],
  );
});

test('delete-only preview starts on the first repeat and keeps later repeats actionable', () => {
  assert.deepEqual(
    buildDuplicateTextActionPreview(
      {
        duplicateBotMessageEnabled: false,
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: false,
        duplicateBanEnabled: false,
        duplicateMuteDurationHours: 6,
      },
      0,
    ),
    [
      { label: 'Первое сообщение', action: 'Остаётся в чате' },
      { label: 'Дубль №1 и далее', action: 'Удаление' },
    ],
  );
});

test('preview sanctions follow the shared thresholds for every stage combination', () => {
  for (let mask = 0; mask < 16; mask += 1) {
    const settings = {
      duplicateBotMessageEnabled: Boolean(mask & 1),
      duplicateWarnEnabled: Boolean(mask & 2),
      duplicateMuteEnabled: Boolean(mask & 4),
      duplicateBanEnabled: Boolean(mask & 8),
      duplicateMuteDurationHours: 6,
    };
    const allowedCount = resolveDuplicateAllowedCountMax(settings);
    const thresholds = buildDuplicateFlowSettings({ ...settings, allowedCount, windowSec: 3600 });
    const preview = buildDuplicateTextActionPreview(settings, allowedCount);
    for (const [enabled, threshold, action] of [
      [
        settings.duplicateWarnEnabled,
        thresholds.duplicateWarnMaxCount,
        'Удаление и предупреждение',
      ],
      [
        settings.duplicateMuteEnabled,
        thresholds.duplicateMuteMaxCount,
        'Удаление и ограничение на 6 ч',
      ],
      [
        settings.duplicateBanEnabled,
        thresholds.duplicateBanMaxCount,
        'Удаление и блокировка навсегда',
      ],
    ] as const) {
      const row = preview.find((item) => item.action === action);
      assert.equal(Boolean(row), enabled);
      if (row) assert.match(row.label, new RegExp(`^Дубль №${threshold}(?: и далее)?$`, 'u'));
    }
  }
});

test('duplicate flow clamps the shared window without changing saturated thresholds', () => {
  assert.deepEqual(
    buildDuplicateFlowSettings({
      duplicateBotMessageEnabled: true,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      allowedCount: 99,
      windowSec: 900_000,
    }),
    {
      duplicateWarnWindowSec: 604_800,
      duplicateMuteWindowSec: 604_800,
      duplicateBanWindowSec: 604_800,
      duplicateWarnMaxCount: 18,
      duplicateMuteMaxCount: 19,
      duplicateBanMaxCount: 20,
    },
  );
});
