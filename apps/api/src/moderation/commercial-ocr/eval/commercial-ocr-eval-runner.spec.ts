import type { ChatSettings } from '../../../prisma/prisma-client';
import type { CommercialOcrEvalRunProvenance } from '../../../scripts/commercial-run-provenance.util';
import { CommercialAdDetector } from '../../commercial/commercial-ad.detector';
import { runCommercialOcrAlbumSchedule } from '../commercial-ocr-album-scheduler';
import type { CommercialOcrPass } from '../commercial-ocr-decision-policy';
import { fingerprintCommercialOcrSettingsProfile } from '../commercial-ocr-settings-profile';
import {
  mapCommercialOcrEvalWithConcurrency,
  resolveCommercialOcrEvalExecutionConfig,
  runCommercialOcrEval,
  type CommercialOcrEvalRunnerDependencies,
} from './commercial-ocr-eval-runner';
import type { CommercialOcrEvalManifest } from './commercial-ocr-eval.schema';

const DELETE_TEXT =
  'Милые дамы, приглашаю вас на маникюр и педикюр. Действует акция: при депиляции подарок. Цена за две процедуры 1200 рублей. Запись по телефону +7 900 000 00 20.';
const DELETE_PASS: CommercialOcrPass = {
  status: 'recognized',
  text: DELETE_TEXT,
  confidencePermille: 960,
  criticalEvidence: [
    { kind: 'commercial_anchor', semanticKey: 'offer:services', confidencePermille: 960 },
    { kind: 'contact', semanticKey: 'phone:+79000000020', confidencePermille: 960 },
    { kind: 'price', semanticKey: 'price:1200', confidencePermille: 960 },
  ],
};
const NO_TEXT_PASS: CommercialOcrPass = {
  status: 'no_text',
  text: '',
  confidencePermille: 0,
  criticalEvidence: [],
};
const BALANCED_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
} as ChatSettings;

describe('commercial OCR eval runner concurrency', () => {
  it('bounds concurrent cases and keeps manifest order in the result', async () => {
    let active = 0;
    let maximumActive = 0;

    const results = await mapCommercialOcrEvalWithConcurrency([4, 1, 3, 2], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 10;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([40, 10, 30, 20]);
  });

  it.each([0, 5, 1.5])('rejects invalid concurrency %p', async (concurrency) => {
    await expect(
      mapCommercialOcrEvalWithConcurrency([1], concurrency, async (value) => value),
    ).rejects.toThrow(/concurrency must be between 1 and 4/u);
  });
});

describe('commercial OCR eval runner scheduling', () => {
  it('expands one schema-v2 source case across every declared settings profile', async () => {
    const fixture = createRunnerFixture();
    const { report, recognizePass, resolveProvenance } = await runFixture(fixture.manifest);

    expect(report.cases).toEqual([
      expect.objectContaining({
        id: 'case-1@balanced-45-65',
        sourceCaseId: 'case-1',
        settingsProfileId: 'balanced-45-65',
        actualCommercialAction: 'DELETE',
        actualEnforcementAction: 'DELETE',
        passed: true,
      }),
      expect.objectContaining({
        id: 'case-1@strict-50-75',
        sourceCaseId: 'case-1',
        settingsProfileId: 'strict-50-75',
        actualCommercialAction: 'DELETE',
        actualEnforcementAction: 'DELETE',
        passed: true,
      }),
    ]);
    expect(new Set(report.cases.map((item) => item.settingsFingerprint)).size).toBe(2);
    expect(report.cases.map((item) => item.settingsFingerprint)).toEqual(
      fixture.manifest.schemaVersion === 2
        ? fixture.manifest.settingsProfiles.map((profile) =>
            fingerprintCommercialOcrSettingsProfile(profile),
          )
        : [],
    );
    expect(report.corpusProvenance).toEqual({
      sourceKind: 'synthetic',
      windowStartedAt: null,
      windowEndedAt: null,
      frozenAt: '2026-08-14T00:00:00.000Z',
      collectionProtocolVersion: 'runner-collection-v1',
      annotationProtocolVersion: 'runner-test-v2',
      collectionArtifactSha256: 'a'.repeat(64),
      adjudicationArtifactSha256: 'b'.repeat(64),
    });
    expect(report.cases[0]).toMatchObject({
      cyrillicGroundTruthEligible: true,
      ocrQuality: {
        expectedPasses: 2,
        attemptedPasses: 2,
        failedPasses: 0,
        expectedPrimaryPasses: 1,
        attemptedPrimaryPasses: 1,
        failedPrimaryPasses: 0,
        expectedConfirmationPasses: 1,
        attemptedConfirmationPasses: 1,
        failedConfirmationPasses: 0,
        characterErrorRate: 0,
        wordErrorRate: 0,
        criticalTokens: 2,
        criticalTokensMatchedBoth: 2,
        criticalTokenRecall: 1,
        confidenceObservations: 2,
        meanAbsoluteConfidenceCalibrationError: 0.04,
        highConfidencePasses: 2,
        highConfidenceSevereErrorRate: 0,
      },
    });
    expect(report.quality).toEqual(report.cases[0]?.ocrQuality);
    expect(resolveProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ manifestSha256: '9'.repeat(64) }),
    );
    expect(recognizePass).toHaveBeenCalledTimes(2);
  });

  it('resolves rejected provenance before detector creation or slow OCR work', async () => {
    const fixture = createRunnerFixture({ profileCount: 1 });
    const createDetector = jest.fn(() => new CommercialAdDetector());
    const recognizePass = jest.fn(async () => {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
      return DELETE_PASS;
    });
    const provenanceError = new Error('provenance unavailable');

    await expect(
      runCommercialOcrEval({
        manifestPath: '/private/corpus/manifest.json',
        dependencies: {
          loadManifest: async () => ({
            manifest: fixture.manifest,
            manifestPath: '/private/corpus/manifest.json',
            manifestSha256: '9'.repeat(64),
            corpusRoot: '/private/corpus',
          }),
          createDetector,
          recognizePass,
          resolveProvenance: async () => {
            throw provenanceError;
          },
        },
      }),
    ).rejects.toBe(provenanceError);
    expect(createDetector).not.toHaveBeenCalled();
    expect(recognizePass).not.toHaveBeenCalled();
  });

  it('runs one profile-independent full quality lane and reuses it between settings profiles', async () => {
    const fixture = createRunnerFixture();
    const trace: string[] = [];
    const { recognizePass } = await runFixture(fixture.manifest, {
      recognizePass: async ({ raw, pass, psm }) => {
        trace.push(`${raw.toString('utf8')}:${pass}:psm-${psm}`);
        return DELETE_PASS;
      },
    });

    expect(trace).toEqual(['image-0:primary:psm-11', 'image-0:confirmation:psm-6']);
    expect(recognizePass).toHaveBeenCalledTimes(2);
  });

  it('matches the shared scheduler traversal trace and terminal decision', async () => {
    const fixture = createRunnerFixture({ imageCount: 2, profileCount: 1 });
    const directTrace: string[] = [];
    const direct = await runCommercialOcrAlbumSchedule<undefined, null>({
      caption: '',
      settings: BALANCED_SETTINGS,
      imageSources: ['direct', 'direct'],
      createImageContext: () => undefined,
      resolvePass: async ({ imageIndex, pass }) => {
        directTrace.push(`${imageIndex}:${pass}`);
        return {
          kind: 'ready',
          value: imageIndex === 0 ? NO_TEXT_PASS : DELETE_PASS,
        };
      },
    });
    const runnerTrace: string[] = [];
    const { report } = await runFixture(fixture.manifest, {
      readImage: async ({ image }) =>
        Buffer.from(image.path === 'image-0.bin' ? 'image-0' : 'image-1'),
      recognizePass: async ({ raw, pass }) => {
        const imageIndex = raw.toString('utf8') === 'image-0' ? 0 : 1;
        runnerTrace.push(`${imageIndex}:${pass}`);
        return imageIndex === 0 ? NO_TEXT_PASS : DELETE_PASS;
      },
    });

    expect(directTrace).toEqual(['0:primary', '1:primary', '1:confirmation']);
    expect(runnerTrace).toEqual(['0:primary', '0:confirmation', '1:primary', '1:confirmation']);
    expect(direct).toMatchObject({ kind: 'complete', decision: { action: 'DELETE' } });
    expect(report.cases[0]).toMatchObject({
      actualCommercialAction: 'DELETE',
      actualEnforcementAction: 'DELETE',
      reasonCodes:
        direct.kind === 'complete' ? direct.decision.reasonCodes : expect.any(Array<string>),
      ocrQuality: {
        expectedPasses: 4,
        attemptedPasses: 4,
        failedPasses: 0,
        expectedPrimaryPasses: 2,
        attemptedPrimaryPasses: 2,
        failedPrimaryPasses: 0,
        expectedConfirmationPasses: 2,
        attemptedConfirmationPasses: 2,
        failedConfirmationPasses: 0,
      },
    });
  });

  it('keeps the full quality lane independent from a caption-safe policy veto', async () => {
    const fixture = createRunnerFixture({
      caption: 'Ищу мастера по установке кондиционера. Бюджет до 5000 руб., пишите в личку.',
      expectedAction: 'NO_ACTION',
      profileCount: 1,
    });
    const verifyImage = jest.fn(async () => undefined);
    const readImage = jest.fn(async () => Buffer.from('verified-image'));
    const recognizePass = jest.fn(async () => DELETE_PASS);
    const { report } = await runFixture(fixture.manifest, {
      verifyImage,
      readImage,
      recognizePass,
    });

    expect(verifyImage).toHaveBeenCalledTimes(1);
    expect(verifyImage).toHaveBeenCalledWith(
      expect.objectContaining({
        corpusRoot: '/private/corpus',
        image: expect.objectContaining({ path: 'image-0.bin' }),
        maxBytes: 16 * 1024 * 1024,
      }),
    );
    expect(readImage).toHaveBeenCalledTimes(1);
    expect(recognizePass).toHaveBeenCalledTimes(2);
    expect(report.cases[0]).toMatchObject({
      actualCommercialAction: 'NO_ACTION',
      actualEnforcementAction: 'NO_ACTION',
      passed: true,
      reasonCodes: ['caption-safe-context:request_or_recommendation'],
      ocrQuality: expect.objectContaining({
        expectedPasses: 2,
        attemptedPasses: 2,
        failedPasses: 0,
      }),
    });
  });

  it('prevalidates the whole album, then loads only the current scheduled image', async () => {
    const fixture = createRunnerFixture({ imageCount: 2, profileCount: 1 });
    const events: string[] = [];
    await runFixture(fixture.manifest, {
      verifyImage: async ({ image }) => {
        events.push(`verify:${image.path}`);
      },
      readImage: async ({ image }) => {
        events.push(`read:${image.path}`);
        return Buffer.from(image.path, 'utf8');
      },
      recognizePass: async ({ raw, pass }) => {
        events.push(`recognize:${raw.toString('utf8')}:${pass}`);
        return raw.toString('utf8') === 'image-0.bin' ? NO_TEXT_PASS : DELETE_PASS;
      },
    });

    expect(events).toEqual([
      'verify:image-0.bin',
      'verify:image-1.bin',
      'read:image-0.bin',
      'recognize:image-0.bin:primary',
      'recognize:image-0.bin:confirmation',
      'read:image-1.bin',
      'recognize:image-1.bin:primary',
      'recognize:image-1.bin:confirmation',
    ]);
  });

  it('records failed primary and confirmation coverage without borrowing across profiles', async () => {
    const fixture = createRunnerFixture();
    const { report, recognizePass } = await runFixture(fixture.manifest, {
      recognizePass: async ({ pass }) => (pass === 'primary' ? DELETE_PASS : null),
    });

    expect(recognizePass).toHaveBeenCalledTimes(2);
    expect(report.cases).toHaveLength(2);
    for (const result of report.cases) {
      expect(result).toMatchObject({
        actualCommercialAction: 'INCOMPLETE',
        actualEnforcementAction: 'INCOMPLETE',
        ocrQuality: {
          expectedPasses: 2,
          attemptedPasses: 2,
          failedPasses: 1,
          expectedPrimaryPasses: 1,
          attemptedPrimaryPasses: 1,
          failedPrimaryPasses: 0,
          expectedConfirmationPasses: 1,
          attemptedConfirmationPasses: 1,
          failedConfirmationPasses: 1,
        },
      });
    }
  });

  it('reports an exact unattempted coverage gap when image verification fails', async () => {
    const fixture = createRunnerFixture({ profileCount: 1 });
    const { report, readImage, recognizePass } = await runFixture(fixture.manifest, {
      verifyImage: async () => {
        throw new Error('digest mismatch');
      },
    });

    expect(readImage).not.toHaveBeenCalled();
    expect(recognizePass).not.toHaveBeenCalled();
    expect(report.cases[0]).toMatchObject({
      actualCommercialAction: 'INCOMPLETE',
      actualEnforcementAction: 'INCOMPLETE',
      ocrQuality: {
        expectedPasses: 2,
        attemptedPasses: 0,
        failedPasses: 0,
        expectedPrimaryPasses: 1,
        attemptedPrimaryPasses: 0,
        failedPrimaryPasses: 0,
        expectedConfirmationPasses: 1,
        attemptedConfirmationPasses: 0,
        failedConfirmationPasses: 0,
      },
    });
  });

  it('creates one detector for the whole eval run', async () => {
    const fixture = createRunnerFixture({ profileCount: 1 });
    if (fixture.manifest.schemaVersion !== 2) throw new Error('expected schema v2 fixture');
    fixture.manifest.cases.push({
      ...fixture.manifest.cases[0]!,
      id: 'case-2',
      clusterId: 'cluster-2',
      images: fixture.manifest.cases[0]!.images.map((image) => ({
        ...image,
        sha256: 'b'.repeat(64),
      })),
    });
    const createDetector = jest.fn(() => new CommercialAdDetector());

    await runFixture(fixture.manifest, { createDetector });

    expect(createDetector).toHaveBeenCalledTimes(1);
  });

  it('keeps source and prepared-image byte ceilings independent', () => {
    const execution = resolveCommercialOcrEvalExecutionConfig(
      {
        get: (key: string) =>
          ({
            PHOTO_DUPLICATE_MAX_BYTES: 8 * 1024 * 1024,
            COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: 2 * 1024 * 1024,
          })[key],
      } as never,
      1,
    );

    expect(execution).toMatchObject({
      maxSourceImageBytes: 8 * 1024 * 1024,
      maxImageBytes: 2 * 1024 * 1024,
      ompThreadLimit: 1,
    });
  });
});

function createRunnerFixture(
  options: {
    imageCount?: number;
    profileCount?: 1 | 2;
    caption?: string;
    expectedAction?: 'DELETE' | 'NO_ACTION';
  } = {},
): { manifest: CommercialOcrEvalManifest } {
  const profileCount = options.profileCount ?? 2;
  const expectedAction = options.expectedAction ?? 'DELETE';
  const settingsProfiles = [
    {
      id: 'balanced-45-65',
      commercialAdsSensitivity: 'BALANCED' as const,
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
    {
      id: 'strict-50-75',
      commercialAdsSensitivity: 'STRICT' as const,
      commercialAdsWarnThreshold: 50,
      commercialAdsDeleteThreshold: 75,
    },
  ].slice(0, profileCount);
  const images = Array.from({ length: options.imageCount ?? 1 }, (_, imageIndex) => ({
    path: `image-${imageIndex}.bin`,
    sha256: String(imageIndex + 1).repeat(64),
    source: 'direct' as const,
    imageTextScript: 'cyrillic_only' as const,
    transcript: imageIndex === 0 && (options.imageCount ?? 1) > 1 ? '' : DELETE_TEXT,
    visualConditions: ['clean' as const],
    criticalTokens:
      imageIndex === 0 && (options.imageCount ?? 1) > 1
        ? []
        : [
            { kind: 'commercial_anchor' as const, value: 'маникюр' },
            { kind: 'phone' as const, value: '+79000000020' },
          ],
  }));
  const manifest: CommercialOcrEvalManifest = {
    schemaVersion: 2,
    corpusId: 'runner-test-corpus',
    corpusRevision: 'runner-v2',
    provenance: {
      sourceKind: 'synthetic',
      windowStartedAt: null,
      windowEndedAt: null,
      frozenAt: '2026-08-14T00:00:00.000Z',
      collectionProtocolVersion: 'runner-collection-v1',
      annotationProtocolVersion: 'runner-test-v2',
      collectionArtifact: {
        path: 'provenance/collection.json',
        sha256: 'a'.repeat(64),
      },
      adjudicationArtifact: {
        path: 'provenance/adjudication.json',
        sha256: 'b'.repeat(64),
      },
    },
    settingsProfiles,
    cases: [
      {
        id: 'case-1',
        clusterId: 'cluster-1',
        split: 'development',
        language: 'ru',
        captionLanguage: options.caption ? 'ru' : 'none',
        category: 'services',
        ...(expectedAction === 'DELETE' ? { commercialSubtype: 'SERVICES' as const } : {}),
        statisticsRepresentative: false,
        expectations: settingsProfiles.map((profile) => ({
          settingsProfileId: profile.id,
          expectedCommercialAction: expectedAction,
          expectedEnforcementAction: expectedAction,
        })),
        caption: options.caption ?? '',
        annotation: {
          annotatorIds: ['reviewer-a', 'reviewer-b'],
          adjudication: 'agreement',
          reviewedAt: '2026-08-13T00:00:00.000Z',
          reviewerDecisions: ['reviewer-a', 'reviewer-b'].map((reviewerId, reviewerIndex) => ({
            reviewerId,
            evidenceSha256: String(reviewerIndex + 3).repeat(64),
            commercialSubtype: expectedAction === 'DELETE' ? ('SERVICES' as const) : null,
            expectations: settingsProfiles.map((profile) => ({
              settingsProfileId: profile.id,
              expectedCommercialAction: expectedAction,
              expectedEnforcementAction: expectedAction,
            })),
          })),
        },
        images,
      },
    ],
  };
  return { manifest };
}

async function runFixture(
  manifest: CommercialOcrEvalManifest,
  overrides: Partial<CommercialOcrEvalRunnerDependencies> = {},
) {
  const readImage = jest.fn(
    overrides.readImage ?? (async () => Buffer.from('image-0')),
  ) as jest.MockedFunction<CommercialOcrEvalRunnerDependencies['readImage']>;
  const recognizePass = jest.fn(
    overrides.recognizePass ?? (async () => DELETE_PASS),
  ) as jest.MockedFunction<CommercialOcrEvalRunnerDependencies['recognizePass']>;
  const verifyImage = jest.fn(
    overrides.verifyImage ?? (async () => undefined),
  ) as jest.MockedFunction<CommercialOcrEvalRunnerDependencies['verifyImage']>;
  const createDetector = jest.fn(
    overrides.createDetector ?? (() => new CommercialAdDetector()),
  ) as jest.MockedFunction<CommercialOcrEvalRunnerDependencies['createDetector']>;
  const resolveProvenance = jest.fn(
    overrides.resolveProvenance ?? (async () => ({}) as CommercialOcrEvalRunProvenance),
  ) as jest.MockedFunction<CommercialOcrEvalRunnerDependencies['resolveProvenance']>;
  const dependencies: Partial<CommercialOcrEvalRunnerDependencies> = {
    loadManifest: async () => ({
      manifest,
      manifestPath: '/private/corpus/manifest.json',
      manifestSha256: '9'.repeat(64),
      corpusRoot: '/private/corpus',
    }),
    readImage,
    verifyImage,
    createDetector,
    recognizePass,
    resolveProvenance,
  };
  const report = await runCommercialOcrEval({
    manifestPath: '/private/corpus/manifest.json',
    dependencies,
  });
  return { report, readImage, verifyImage, createDetector, recognizePass, resolveProvenance };
}
