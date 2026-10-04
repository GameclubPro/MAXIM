import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommercialOcrEvalRunProvenance } from '../../../scripts/commercial-run-provenance.util';
import { CommercialAdDetector } from '../../commercial/commercial-ad.detector';
import { createCommercialOcrEvalCertificationRequest } from './commercial-ocr-eval-certification';
import {
  evaluateCommercialOcrEvalGates,
  evaluateCommercialOcrPairedCandidateQualityGates,
} from './commercial-ocr-eval-gates';
import {
  evaluateCommercialOcrPairedPrivatePhotos,
  pairedErrors,
} from './commercial-ocr-paired-private';
import {
  runCommercialOcrPairedEval,
  type CommercialOcrEvalRunnerDependencies,
} from './commercial-ocr-eval-runner';
import { loadCommercialOcrEvalManifest } from './commercial-ocr-eval.schema';
import type { CommercialOcrPass } from '../commercial-ocr-decision-policy';

const OFFER =
  'Милые дамы, приглашаю вас на маникюр и педикюр. Действует акция: при депиляции подарок. Цена за две процедуры 1200 рублей. Запись по телефону +7 900 000 00 20.';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const recognized: CommercialOcrPass = {
  status: 'recognized',
  text: OFFER,
  confidencePermille: 960,
  criticalEvidence: [
    { kind: 'commercial_anchor', semanticKey: 'offer:services', confidencePermille: 960 },
    { kind: 'contact', semanticKey: 'phone:+79000000020', confidencePermille: 960 },
    { kind: 'price', semanticKey: 'price:1200', confidencePermille: 960 },
  ],
};

async function corpus() {
  const root = await mkdtemp(join(tmpdir(), 'maxim-paired-private-'));
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(join(root, 'original.png'), image, { mode: 0o600 });
  await writeFile(join(root, 'collection.json'), '{}', { mode: 0o600 });
  await writeFile(join(root, 'adjudication.json'), '{"private":"artifact"}', { mode: 0o600 });
  const profiles = [
    {
      id: 'private-profile',
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  ];
  const expectations = profiles.map((profile) => ({
    settingsProfileId: profile.id,
    expectedCommercialAction: 'DELETE',
    expectedEnforcementAction: 'DELETE',
  }));
  const manifest = {
    schemaVersion: 2,
    corpusId: 'private-corpus',
    corpusRevision: 'private-revision',
    provenance: {
      sourceKind: 'synthetic',
      windowStartedAt: null,
      windowEndedAt: null,
      frozenAt: '2026-09-30T00:00:00.000Z',
      collectionProtocolVersion: 'production-temporal-random-v1',
      annotationProtocolVersion: 'ocr-adjudication-v2',
      collectionArtifact: { path: 'collection.json', sha256: sha('{}') },
      adjudicationArtifact: { path: 'adjudication.json', sha256: sha('{"private":"artifact"}') },
    },
    settingsProfiles: profiles,
    cases: [
      {
        id: 'private-case',
        clusterId: 'private-cluster',
        split: 'holdout',
        language: 'ru',
        captionLanguage: 'none',
        category: 'private-category',
        commercialSubtype: 'SERVICES',
        statisticsRepresentative: true,
        expectations,
        caption: '',
        annotation: {
          annotatorIds: ['private-reviewer-a', 'private-reviewer-b'],
          adjudication: 'agreement',
          reviewedAt: '2026-09-29T00:00:00.000Z',
          reviewerDecisions: ['private-reviewer-a', 'private-reviewer-b'].map((reviewerId) => ({
            reviewerId,
            evidenceSha256: sha(reviewerId),
            commercialSubtype: 'SERVICES',
            expectations,
          })),
        },
        images: [
          {
            path: 'original.png',
            sha256: sha(image),
            source: 'direct',
            imageTextScript: 'cyrillic_only',
            transcript: OFFER,
            visualConditions: ['clean'],
            criticalTokens: [
              { kind: 'commercial_anchor', value: 'маникюр' },
              { kind: 'phone', value: '+79000000020' },
            ],
          },
        ],
      },
    ],
  };
  const manifestPath = join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return { root, manifestPath, manifest };
}
const provenance = () =>
  ({
    artifact: { manifestSha256: '9'.repeat(64) },
    behaviorIdentity: { nativeFingerprintSha256: '8'.repeat(64) },
    fingerprints: { policy: { version: 'commercial-ocr-delete-policy-v2' } },
  }) as CommercialOcrEvalRunProvenance;

describe('readonly paired original-photo evaluation', () => {
  it('recognizes two passes once and feeds the identical immutable observations to both policies', async () => {
    const data = await corpus();
    try {
      const recognizePass = jest.fn(
        async (_input: Parameters<CommercialOcrEvalRunnerDependencies['recognizePass']>[0]) =>
          recognized,
      );
      const baselineInputs: unknown[] = [];
      const candidateInputs: unknown[] = [];
      const createDetector = () => ({
        detect: (input: Parameters<CommercialAdDetector['detect']>[0]) => {
          baselineInputs.push(input);
          return new CommercialAdDetector().detect(input);
        },
      });
      const reports = await runCommercialOcrPairedEval({
        manifestPath: data.manifestPath,
        dependencies: {
          recognizePass,
          createDetector,
          resolveProvenance: async () => provenance(),
        },
        createCandidateDetector: () => ({
          detect: (input) => {
            candidateInputs.push(input);
            return new CommercialAdDetector().detectExperimental(input);
          },
        }),
      });
      expect(recognizePass).toHaveBeenCalledTimes(2);
      expect(recognizePass.mock.calls.map((call) => call[0].psm)).toEqual([11, 6]);
      expect(candidateInputs).toEqual(baselineInputs);
      expect(reports.candidate.cases[0]?.actualAction).toBe('DELETE');
      expect(reports.baseline.cases[0]?.actualAction).toBe('DELETE');
      expect(reports.candidate.performance).toBe(reports.baseline.performance);
      expect(reports.candidate.quality).toEqual(reports.baseline.quality);
      expect(reports.candidate.readonlyCandidatePolicy?.evaluationIdentitySha256).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      expect(reports.baseline.readonlyCandidatePolicy).toBeUndefined();
      expect(evaluateCommercialOcrEvalGates(reports.candidate).failures).toContain(
        'Readonly paired candidate evidence cannot certify the production OCR baseline',
      );
      expect(
        evaluateCommercialOcrPairedCandidateQualityGates(reports.candidate).failures,
      ).not.toContain(
        'Readonly paired candidate evidence cannot certify the production OCR baseline',
      );
      expect(() =>
        createCommercialOcrEvalCertificationRequest({
          report: reports.candidate,
          gates: { passed: true } as never,
          approvalKeyIdSha256: 'a'.repeat(64),
        }),
      ).toThrow('Readonly paired candidate evidence');
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it('uses actual experimental policy and exports only aggregates with strict denominators', async () => {
    const data = await corpus();
    try {
      const report = await evaluateCommercialOcrPairedPrivatePhotos({
        manifestPath: data.manifestPath,
        dependencies: {
          recognizePass: async () => recognized,
          resolveProvenance: async () => provenance(),
        },
      });
      expect(report.status).toBe('EVALUATED');
      if (!report.evaluated) throw new Error('Expected evaluated report');
      expect(report.comparisons[0]).toMatchObject({
        independentPositiveUnits: 1,
        independentNegativeUnits: 0,
        chainMisses: { units: 1, baselineErrors: 0, candidateErrors: 0 },
      });
      expect(report.candidate.strictGates.passed).toBe(false);
      expect(report.independentImprovementProven).toBe(false);
      expect(report.promotionAuthorized).toBe(false);
      expect(report.executedDeletions).toBe(0);
      expect(JSON.stringify(report)).not.toMatch(
        /private-(case|corpus|cluster|reviewer|profile|category)|маникюр|79000000020|original\.png/u,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it('reports unavailable before native OCR when original bytes changed or two reviews are absent', async () => {
    const data = await corpus();
    try {
      const recognizePass = jest.fn(async () => recognized);
      await writeFile(join(data.root, 'original.png'), Buffer.from('changed'));
      expect(
        await evaluateCommercialOcrPairedPrivatePhotos({
          manifestPath: data.manifestPath,
          dependencies: { recognizePass },
        }),
      ).toMatchObject({
        status: 'UNAVAILABLE',
        reason: 'private_original_images_unavailable_or_changed',
      });
      expect(recognizePass).not.toHaveBeenCalled();
      const loaded = await loadCommercialOcrEvalManifest(data.manifestPath);
      if (loaded.manifest.schemaVersion !== 2) throw new Error('Expected schema v2');
      loaded.manifest.cases[0]!.annotation.reviewerDecisions.pop();
      const report = await evaluateCommercialOcrPairedPrivatePhotos({
        manifestPath: data.manifestPath,
        dependencies: { loadManifest: async () => loaded, recognizePass },
      });
      expect(report).toMatchObject({
        status: 'UNAVAILABLE',
        reason: 'two_independent_original_image_reviews_required',
      });
      expect(recognizePass).not.toHaveBeenCalled();
      expect(await readFile(data.manifestPath, 'utf8')).toContain('private-reviewer-b');
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it('keeps failed confirmation in both policies rather than converting it into a negative', async () => {
    const data = await corpus();
    try {
      const report = await evaluateCommercialOcrPairedPrivatePhotos({
        manifestPath: data.manifestPath,
        dependencies: {
          recognizePass: async (input) => (input.pass === 'primary' ? recognized : null),
          resolveProvenance: async () => provenance(),
        },
      });
      expect(report.status).toBe('INCOMPLETE');
      if (!report.evaluated) throw new Error('Expected evaluated report');
      expect(report.comparisons[0]).toMatchObject({
        baselineIncompletePositiveUnits: 1,
        candidateIncompletePositiveUnits: 1,
        chainMisses: { baselineErrors: 1, candidateErrors: 1 },
      });
      expect(report.pairedReductionSupportedWithinProvidedCorpus).toBe(false);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it('requires a significant paired reduction and never treats unchanged/empty pairs as improvement', () => {
    expect(pairedErrors([]).significantReduction).toBe(false);
    expect(
      pairedErrors([
        [false, false],
        [true, true],
      ]).significantReduction,
    ).toBe(false);
    const correction = pairedErrors(Array.from({ length: 6 }, () => [true, false] as const));
    expect(correction).toMatchObject({
      units: 6,
      correctedUnits: 6,
      regressedUnits: 0,
      significantReduction: true,
    });
    expect(correction.oneSidedExactP).toBeCloseTo(0.015625, 12);
    expect(
      pairedErrors([
        [true, false],
        [false, true],
      ]).significantReduction,
    ).toBe(false);
  });
});
