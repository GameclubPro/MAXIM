import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import {
  buildDuplicateFlowSettings,
  normalizeDuplicateFlowSettings,
  resolveDuplicateAllowedCount,
  resolveDuplicateAllowedCountMax,
} from '../src/pages/settings/settings-duplicate-flow';

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
