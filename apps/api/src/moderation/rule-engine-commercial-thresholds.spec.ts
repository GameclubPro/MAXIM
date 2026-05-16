import { CommercialAdsSensitivity } from '@prisma/client';
import { resolveCommercialThresholds } from './rule-engine-commercial-thresholds';

describe('resolveCommercialThresholds', () => {
  it('keeps balanced sensitivity with bounded thresholds', () => {
    expect(
      resolveCommercialThresholds({
        commercialAdsSensitivity: CommercialAdsSensitivity.BALANCED,
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      }),
    ).toEqual({
      warnThreshold: 45,
      deleteThreshold: 65,
      sensitivity: 'BALANCED',
      strictness: expect.any(Number),
    });
  });

  it('clamps invalid threshold ranges and keeps delete above warn', () => {
    const thresholds = resolveCommercialThresholds({
      commercialAdsSensitivity: CommercialAdsSensitivity.STRICT,
      commercialAdsWarnThreshold: 95,
      commercialAdsDeleteThreshold: 92,
    });

    expect(thresholds.warnThreshold).toBe(90);
    expect(thresholds.deleteThreshold).toBe(95);
    expect(thresholds.sensitivity).toBe('STRICT');
    expect(thresholds.strictness).toBeGreaterThanOrEqual(0);
    expect(thresholds.strictness).toBeLessThanOrEqual(1);
  });

  it('falls back to current production defaults for non-finite values', () => {
    const thresholds = resolveCommercialThresholds({
      commercialAdsSensitivity: CommercialAdsSensitivity.BALANCED,
      commercialAdsWarnThreshold: Number.NaN,
      commercialAdsDeleteThreshold: Number.NaN,
    });

    expect(thresholds.warnThreshold).toBe(45);
    expect(thresholds.deleteThreshold).toBe(65);
  });
});
