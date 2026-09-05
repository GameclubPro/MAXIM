import type { ChatSettings } from '../prisma/prisma-client';
import {
  duplicateFlowConfigsEqual,
  resolveDuplicateFlowConfig,
  resolveDuplicateFlowOutcome,
} from './duplicate-flow-policy';

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    duplicateWarnEnabled: true,
    duplicateWarnMaxCount: 3,
    duplicateWarnWindowSec: 43_200,
    duplicateMuteEnabled: true,
    duplicateMuteMaxCount: 4,
    duplicateMuteWindowSec: 86_400,
    duplicateBanEnabled: true,
    duplicateBanMaxCount: 5,
    duplicateBanWindowSec: 172_800,
    duplicateBotMessageEnabled: true,
    ...overrides,
  } as ChatSettings;
}

describe('duplicate flow policy', () => {
  it('preserves the explanation, warning, mute and ban ladder', () => {
    const flow = resolveDuplicateFlowConfig(settings());
    expect(flow.allowedCount).toBe(1);
    expect(flow.reactions).toEqual([
      { action: null },
      { action: 'WARN' },
      { action: 'MUTE' },
      { action: 'BAN' },
    ]);

    const passiveOutcome = resolveDuplicateFlowOutcome({
      settings: settings(),
      repeatCount: 2,
      hash: 'hash-1',
      fingerprintType: 'image',
    });
    expect(passiveOutcome.hit).toMatchObject({ count: 2 });
    expect(passiveOutcome.decision).toBeUndefined();
    expect(
      resolveDuplicateFlowOutcome({
        settings: settings(),
        repeatCount: 3,
        hash: 'hash-1',
        fingerprintType: 'image',
      }).decision,
    ).toMatchObject({ action: 'WARN', nextAction: 'MUTE' });
  });

  it('produces a deletion hit without a sanction when every reaction is disabled', () => {
    expect(
      resolveDuplicateFlowOutcome({
        settings: settings({
          duplicateBotMessageEnabled: false,
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: false,
        }),
        repeatCount: 10,
        hash: 'hash-1',
        fingerprintType: 'image',
      }),
    ).toEqual({
      hit: {
        count: 10,
        windowSec: 43_200,
        hash: 'hash-1',
        fingerprintType: 'image',
      },
    });
  });

  it('keeps every enabled sanction reachable inside the shared threshold ceiling', () => {
    const boundedSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnMaxCount: 20,
      duplicateMuteMaxCount: 20,
      duplicateBanMaxCount: 20,
    });

    expect(resolveDuplicateFlowConfig(boundedSettings).allowedCount).toBe(17);
    expect(
      [18, 19, 20].map(
        (repeatCount) =>
          resolveDuplicateFlowOutcome({
            settings: boundedSettings,
            repeatCount,
            hash: 'bounded-ladder',
            fingerprintType: 'exact',
          }).decision?.action,
      ),
    ).toEqual(['WARN', 'MUTE', 'BAN']);
  });

  it('preserves a WARN-only threshold of 20', () => {
    const warnOnlySettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      duplicateWarnMaxCount: 20,
    });

    expect(resolveDuplicateFlowConfig(warnOnlySettings).allowedCount).toBe(19);
    expect(
      resolveDuplicateFlowOutcome({
        settings: warnOnlySettings,
        repeatCount: 20,
        hash: 'warn-only-20',
        fingerprintType: 'exact',
      }).decision?.action,
    ).toBe('WARN');
  });

  it('detects changes to the window, threshold or reaction ladder', () => {
    const original = resolveDuplicateFlowConfig(settings());
    expect(duplicateFlowConfigsEqual(original, resolveDuplicateFlowConfig(settings()))).toBe(true);
    expect(
      duplicateFlowConfigsEqual(
        original,
        resolveDuplicateFlowConfig(settings({ duplicateWarnWindowSec: 60 })),
      ),
    ).toBe(false);
    expect(
      duplicateFlowConfigsEqual(
        original,
        resolveDuplicateFlowConfig(settings({ duplicateWarnMaxCount: 4 })),
      ),
    ).toBe(false);
    expect(
      duplicateFlowConfigsEqual(
        original,
        resolveDuplicateFlowConfig(settings({ duplicateMuteEnabled: false })),
      ),
    ).toBe(false);
  });
});
