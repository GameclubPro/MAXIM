import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialOcrDetector, CommercialOcrPass } from './commercial-ocr-decision-policy';
import { runCommercialOcrAlbumSchedule } from './commercial-ocr-album-scheduler';

const SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
} as unknown as ChatSettings;

const PASS: CommercialOcrPass = {
  status: 'recognized',
  text: 'Ремонт окон, звоните +7 999 123 45 67',
  confidencePermille: 960,
  criticalEvidence: [
    { kind: 'commercial_anchor', semanticKey: 'service:ремонт', confidencePermille: 960 },
    { kind: 'contact', semanticKey: 'phone:+79991234567', confidencePermille: 960 },
  ],
};

function detector(overrides: Record<string, unknown> = {}): CommercialOcrDetector {
  return {
    detect: jest.fn().mockReturnValue({
      confidenceScore: 96,
      actionScore: 96,
      actionBand: 'DELETE',
      matchedSignals: ['service:offer', 'contact:phone'],
      negativeSignals: [],
      primarySubtype: 'SERVICES',
      supportingSubtypes: [],
      evidenceTier: 'DIRECT',
      evidenceStrength: 'DIRECT',
      policyFpRisk: 0,
      reviewRecommended: false,
      reviewReasons: [],
      safeContextBucket: 'none',
      actionable: true,
      recordable: true,
      deleteSuppressed: false,
      suppressionReasons: [],
      reasonCodes: [],
      hasEscalationRiskEvidence: false,
      ...overrides,
    }),
  };
}

describe('commercial OCR album scheduler', () => {
  it('runs confirmation lazily only for a primary delete candidate', async () => {
    const calls: string[] = [];
    const result = await runCommercialOcrAlbumSchedule<undefined, string>({
      caption: '',
      settings: SETTINGS,
      imageSources: ['direct', 'direct'],
      detector: detector(),
      createImageContext: () => undefined,
      resolvePass: async ({ imageIndex, pass }) => {
        calls.push(`${imageIndex}:${pass}`);
        return {
          kind: 'ready',
          value: pass === 'primary' && imageIndex === 0 ? { ...PASS, text: '' } : PASS,
        };
      },
    });

    expect(result).toMatchObject({ kind: 'complete', decision: { action: 'DELETE' } });
    expect(calls).toEqual(['0:primary', '1:primary', '1:confirmation']);
  });

  it('runs caption veto before preflight and image work', async () => {
    const preflight = jest.fn();
    const resolvePass = jest.fn();
    const result = await runCommercialOcrAlbumSchedule<undefined, string>({
      caption: 'Ищу мастера, кого можете порекомендовать?',
      settings: SETTINGS,
      imageSources: ['direct'],
      detector: { detect: jest.fn().mockReturnValue(null) },
      preflight,
      createImageContext: () => undefined,
      resolvePass,
    });

    expect(result).toMatchObject({ kind: 'complete', decision: { action: 'NO_ACTION' } });
    expect(preflight).not.toHaveBeenCalled();
    expect(resolvePass).not.toHaveBeenCalled();
  });

  it('propagates a stage stop and always finalizes the current image', async () => {
    const finishImage = jest.fn();
    await expect(
      runCommercialOcrAlbumSchedule<number, string>({
        caption: '',
        settings: SETTINGS,
        imageSources: ['direct'],
        detector: detector(),
        createImageContext: () => 7,
        resolvePass: async () => ({ kind: 'stop', result: 'incomplete' }),
        finishImage,
      }),
    ).resolves.toEqual({ kind: 'stopped', result: 'incomplete' });
    expect(finishImage).toHaveBeenCalledWith(7, 0);
  });

  it('observes each policy evaluation without repeating the terminal decision', async () => {
    const commercialDetector = detector();
    const observePolicyDuration = jest.fn();

    await expect(
      runCommercialOcrAlbumSchedule<undefined, string>({
        caption: '',
        settings: SETTINGS,
        imageSources: ['direct'],
        detector: commercialDetector,
        createImageContext: () => undefined,
        resolvePass: async () => ({ kind: 'ready', value: PASS }),
        observePolicyDuration,
      }),
    ).resolves.toMatchObject({ kind: 'complete', decision: { action: 'DELETE' } });

    expect(commercialDetector.detect).toHaveBeenCalledTimes(3);
    expect(observePolicyDuration).toHaveBeenCalledTimes(2);
    expect(observePolicyDuration).toHaveBeenCalledWith(expect.any(Number));
  });
});
