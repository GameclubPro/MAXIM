import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialDetection } from '../commercial/commercial-ad.detector';
import {
  evaluateCommercialOcrDecision,
  hasCommercialOcrPrimaryDeleteCandidate,
  isCommercialOcrCyrillicOnlyDeleteDecision,
  type CommercialOcrCriticalEvidence,
  type CommercialOcrDetector,
  type CommercialOcrImageDecisionInput,
  type CommercialOcrPass,
} from './commercial-ocr-decision-policy';

const SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
} as unknown as ChatSettings;

const CRITICAL_EVIDENCE: CommercialOcrCriticalEvidence[] = [
  {
    kind: 'commercial_anchor',
    semanticKey: 'service:window-repair',
    confidencePermille: 930,
  },
  { kind: 'contact', semanticKey: 'phone:+79991234567', confidencePermille: 920 },
];

function detection(overrides: Partial<CommercialDetection> = {}): CommercialDetection {
  return {
    rawText: 'recognized commercial text',
    confidenceScore: 96,
    decisionBand: 'HIGH',
    matchedSignals: ['service-specialty:ремонт', 'contact:phone'],
    negativeSignals: [],
    primarySubtype: 'SERVICES',
    supportingSubtypes: [],
    evidenceStrength: 'DIRECT',
    reviewRecommended: false,
    reviewReasons: [],
    campaignContext: null,
    appliedThresholds: {
      warnThreshold: 45,
      deleteThreshold: 65,
      sensitivity: 'BALANCED',
      strictness: 0.5,
    },
    classifierVersion: 'test',
    commercialProbability: 0.99,
    reviewProbability: 0.01,
    classifierReasons: [],
    actionScore: 96,
    policyFpRisk: 0,
    evidenceTier: 'DIRECT',
    actionBand: 'DELETE',
    safeContextBucket: 'none',
    actionable: true,
    recordable: true,
    deleteSuppressed: false,
    suppressionReasons: [],
    reasonCodes: [],
    ...overrides,
  };
}

function detectorFor(
  resolve: (text: string) => CommercialDetection | null = () => detection(),
): CommercialOcrDetector {
  return {
    detect: jest.fn((params) => resolve(params.rawLoweredText)),
  };
}

function recognizedPass(overrides: Partial<CommercialOcrPass> = {}): CommercialOcrPass {
  return {
    status: 'recognized',
    text: 'Ремонт окон, звоните +7 999 123 45 67',
    confidencePermille: 940,
    criticalEvidence: CRITICAL_EVIDENCE,
    ...overrides,
  };
}

function image(
  overrides: Partial<CommercialOcrImageDecisionInput> = {},
): CommercialOcrImageDecisionInput {
  return {
    imageIndex: 0,
    source: 'direct',
    primary: recognizedPass(),
    verification: recognizedPass({ text: 'Ремонт окон. Телефон +7 999 123-45-67' }),
    ...overrides,
  };
}

describe('commercial OCR decision policy', () => {
  it('proposes delete for one image only after two independent strict passes agree', () => {
    const detector = detectorFor();
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image()],
      settings: SETTINGS,
      detector,
    });

    expect(result).toEqual(
      expect.objectContaining({
        action: 'DELETE',
        deleteSource: { kind: 'image', imageIndex: 0, source: 'direct' },
        reasonCodes: ['image-independent-two-pass-delete'],
      }),
    );
    expect(result.images[0]).toEqual(
      expect.objectContaining({ deleteEligible: true, rejectionReasons: [] }),
    );
    expect(detector.detect).toHaveBeenCalledTimes(2);
  });

  it('does not combine evidence from different images', () => {
    const detector = detectorFor((text) =>
      text.includes('только услуга')
        ? detection({
            actionBand: 'WARN',
            confidenceScore: 70,
            actionScore: 70,
            evidenceTier: 'STRUCTURED',
          })
        : detection({
            actionBand: 'WARN',
            confidenceScore: 70,
            actionScore: 70,
            evidenceTier: 'BORDERLINE',
          }),
    );
    const serviceOnly = recognizedPass({
      text: 'Только услуга ремонта пластиковых окон',
      criticalEvidence: [CRITICAL_EVIDENCE[0]],
    });
    const contactOnly = recognizedPass({
      text: 'Только контакт для связи +7 999 123 45 67',
      criticalEvidence: [CRITICAL_EVIDENCE[1]],
    });

    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 2,
      images: [
        image({ imageIndex: 0, primary: serviceOnly, verification: serviceOnly }),
        image({ imageIndex: 1, primary: contactOnly, verification: contactOnly }),
      ],
      settings: SETTINGS,
      detector,
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.images.every((entry) => !entry.deleteEligible)).toBe(true);
    expect(result.reasonCodes).toEqual(['no-independent-delete-source']);
  });

  it('lets a safe caption veto an otherwise eligible image', () => {
    const result = evaluateCommercialOcrDecision({
      caption: 'Ищу мастера по ремонту, бюджет 5000 рублей. Кто может посоветовать?',
      expectedImageCount: 1,
      images: [image()],
      settings: SETTINGS,
      detector: detectorFor((text) => (text.startsWith('ищу') ? null : detection())),
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.caption.safeContextBucket).toBe('request_or_recommendation');
    expect(result.reasonCodes).toEqual(['caption-safe-context:request_or_recommendation']);
    expect(result.images[0]?.deleteEligible).toBe(true);
  });

  it('lets safe context from any OCR pass veto album enforcement', () => {
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 2,
      images: [image(), image({ imageIndex: 1 })],
      settings: SETTINGS,
      detector: detectorFor((text) =>
        text.includes('ремонт окон. телефон')
          ? detection({ safeContextBucket: 'request_or_recommendation' })
          : detection(),
      ),
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.reasonCodes).toEqual(['image-safe-context:0:request_or_recommendation']);
  });

  it('rejects WARN even at high scores', () => {
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image()],
      settings: SETTINGS,
      detector: detectorFor(() => detection({ actionBand: 'WARN' })),
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.images[0]?.primary.rejectionReasons).toContain('detector-action-not-delete');
  });

  it('accepts independently confirmed escalation-grade high-risk goods', () => {
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image()],
      settings: SETTINGS,
      detector: detectorFor(() =>
        detection({
          actionBand: 'DELETE_AND_ESCALATE',
          evidenceTier: 'HIGH_RISK',
          hasEscalationRiskEvidence: true,
          reasonCodes: ['action:DELETE_AND_ESCALATE', 'risk:escalation-grade'],
          primarySubtype: 'GOODS',
        }),
      ),
    });

    expect(result.action).toBe('DELETE');
    expect(result.images[0]?.deleteEligible).toBe(true);
  });

  it.each([
    ['wrong tier', { evidenceTier: 'DIRECT' }],
    ['missing risk evidence', { hasEscalationRiskEvidence: false }],
    ['missing risk reason', { reasonCodes: ['action:DELETE_AND_ESCALATE'] }],
  ] satisfies Array<[string, Partial<CommercialDetection>]>)(
    'rejects malformed DELETE_AND_ESCALATE with %s',
    (_label, overrides) => {
      const result = evaluateCommercialOcrDecision({
        caption: '',
        expectedImageCount: 1,
        images: [image()],
        settings: SETTINGS,
        detector: detectorFor(() =>
          detection({
            actionBand: 'DELETE_AND_ESCALATE',
            evidenceTier: 'HIGH_RISK',
            hasEscalationRiskEvidence: true,
            reasonCodes: ['action:DELETE_AND_ESCALATE', 'risk:escalation-grade'],
            primarySubtype: 'GOODS',
            ...overrides,
          }),
        ),
      });

      expect(result.action).toBe('NO_ACTION');
      expect(result.images[0]?.primary.rejectionReasons).toContain('detector-action-not-delete');
    },
  );

  it.each([
    ['aggregate confidence', { confidencePermille: 899 }, 'ocr-confidence-too-low'],
    [
      'critical confidence',
      {
        criticalEvidence: [
          CRITICAL_EVIDENCE[0],
          { ...CRITICAL_EVIDENCE[1], confidencePermille: 849 },
        ],
      },
      'ocr-critical-confidence-too-low',
    ],
    [
      'commercial critical anchor',
      { criticalEvidence: [CRITICAL_EVIDENCE[1]] },
      'ocr-critical-evidence-missing',
    ],
  ])('rejects a pass below the %s gate', (_label, passOverrides, rejectionReason) => {
    const failing = recognizedPass(passOverrides);
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image({ primary: failing, verification: failing })],
      settings: SETTINGS,
      detector: detectorFor(),
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.images[0]?.primary.rejectionReasons).toContain(rejectionReason);
  });

  it('requires the second pass to agree on subtype and critical semantic evidence', () => {
    const detector = detectorFor((text) =>
      text.includes('другая услуга')
        ? detection({ primarySubtype: 'RECRUITMENT' })
        : detection({ primarySubtype: 'SERVICES' }),
    );
    const verification = recognizedPass({
      text: 'Другая услуга, звоните +7 999 123 45 67',
      criticalEvidence: [
        {
          kind: 'commercial_anchor',
          semanticKey: 'recruitment:vacancy',
          confidencePermille: 930,
        },
        CRITICAL_EVIDENCE[1],
      ],
    });
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image({ verification })],
      settings: SETTINGS,
      detector,
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.images[0]?.rejectionReasons).toEqual(
      expect.arrayContaining(['detector-subtype-disagreement', 'critical-evidence-disagreement']),
    );
  });

  it.each(['GENERIC', 'GOODS'] as const)('excludes the ambiguous %s subtype', (primarySubtype) => {
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image()],
      settings: SETTINGS,
      detector: detectorFor(() => detection({ primarySubtype })),
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.images[0]?.primary.rejectionReasons).toContain('detector-subtype-excluded');
  });

  it('fails open when the declared image set is incomplete', () => {
    const result = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 2,
      images: [image()],
      settings: SETTINGS,
      detector: detectorFor(),
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.reasonCodes).toEqual(['image-set-incomplete']);
  });

  it('never creates a caption-only action in the image OCR path', () => {
    const result = evaluateCommercialOcrDecision({
      caption: 'Ремонт окон, цена 5000 рублей, звоните +7 999 123 45 67',
      expectedImageCount: 0,
      images: [],
      settings: SETTINGS,
      detector: detectorFor(),
    });

    expect(result.action).toBe('NO_ACTION');
    expect(result.deleteSource).toBeNull();
    expect(result.reasonCodes).toEqual(['no-independent-delete-source']);
  });

  it('exposes a confirmation candidate without weakening the final two-pass decision', () => {
    const primaryOnly = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image({ verification: null })],
      settings: SETTINGS,
      detector: detectorFor(),
    });

    expect(primaryOnly.action).toBe('NO_ACTION');
    expect(hasCommercialOcrPrimaryDeleteCandidate(primaryOnly)).toBe(true);
    expect(
      hasCommercialOcrPrimaryDeleteCandidate({
        ...primaryOnly,
        images: primaryOnly.images.map((entry) => ({
          ...entry,
          primary: { ...entry.primary, deleteEligible: false },
        })),
      }),
    ).toBe(false);
  });

  it('allows the first enforcement cohort only for two Cyrillic-only OCR passes', () => {
    const detector = detectorFor((text) => detection({ rawText: text }));
    const ruDecision = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image()],
      settings: SETTINGS,
      detector,
    });
    const enDecision = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [
        image({
          primary: recognizedPass({ text: 'Window repair call +7 999 123 45 67' }),
          verification: recognizedPass({ text: 'Window repair phone +7 999 123 45 67' }),
        }),
      ],
      settings: SETTINGS,
      detector,
    });
    const mixedDecision = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [
        image({
          primary: recognizedPass({ text: 'Ремонт окон call +7 999 123 45 67' }),
          verification: recognizedPass({ text: 'Ремонт окон телефон +7 999 123 45 67' }),
        }),
      ],
      settings: SETTINGS,
      detector,
    });

    expect(ruDecision.action).toBe('DELETE');
    expect(isCommercialOcrCyrillicOnlyDeleteDecision(ruDecision)).toBe(true);
    expect(enDecision.action).toBe('DELETE');
    expect(isCommercialOcrCyrillicOnlyDeleteDecision(enDecision)).toBe(false);
    expect(mixedDecision.action).toBe('DELETE');
    expect(isCommercialOcrCyrillicOnlyDeleteDecision(mixedDecision)).toBe(false);
  });

  it('keeps a Cyrillic delete source report-only when another album pass contains Latin text', () => {
    const detector = detectorFor((text) => detection({ rawText: text }));
    const decision = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 2,
      images: [
        image(),
        image({
          imageIndex: 1,
          primary: recognizedPass({ text: 'Window repair call +7 999 123 45 67' }),
          verification: recognizedPass({ text: 'Window repair phone +7 999 123 45 67' }),
        }),
      ],
      settings: SETTINGS,
      detector,
    });

    expect(decision.action).toBe('DELETE');
    expect(isCommercialOcrCyrillicOnlyDeleteDecision(decision)).toBe(false);
  });

  it('keeps phone-only OCR evidence report-only when no letter script can be established', () => {
    const detector = detectorFor((text) => detection({ rawText: text }));
    const phoneOnly = recognizedPass({ text: '+7 999 123 45 67, 5000' });
    const decision = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image({ primary: phoneOnly, verification: phoneOnly })],
      settings: SETTINGS,
      detector,
    });

    expect(decision.action).toBe('DELETE');
    expect(decision.images[0]?.primary.letterScript).toBe('unknown');
    expect(decision.images[0]?.verification?.letterScript).toBe('unknown');
    expect(isCommercialOcrCyrillicOnlyDeleteDecision(decision)).toBe(false);
  });

  it('rejects a token Cyrillic marker surrounded by numeric commercial evidence', () => {
    const detector = detectorFor((text) => detection({ rawText: text }));
    const adversarial = recognizedPass({ text: 'я +7 999 123 45 67, 5000' });
    const decision = evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [image({ primary: adversarial, verification: adversarial })],
      settings: SETTINGS,
      detector,
    });

    expect(decision.action).toBe('DELETE');
    expect(decision.images[0]?.primary).toMatchObject({
      letterScript: 'cyrillic_only',
      cyrillicLetterCount: 1,
      latinLetterCount: 0,
    });
    expect(isCommercialOcrCyrillicOnlyDeleteDecision(decision)).toBe(false);
  });
});
