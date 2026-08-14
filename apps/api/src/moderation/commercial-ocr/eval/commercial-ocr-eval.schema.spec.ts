import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS } from '../commercial-ocr-decision-policy';
import {
  COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
  commercialOcrEvalManifestSchema,
  criticalTokenAppearsInTranscript,
  loadCommercialOcrEvalManifest,
  normalizeCommercialOcrEvalCriticalToken,
  readVerifiedCommercialOcrEvalImage,
} from './commercial-ocr-eval.schema';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('commercial OCR eval corpus schema', () => {
  it('requires opaque unique case ids and immutable image digests', () => {
    const manifest = {
      schemaVersion: 1,
      corpusId: 'public-smoke',
      corpusRevision: 'v1',
      cases: [
        {
          id: 'safe-1',
          clusterId: 'safe-cluster-1',
          language: 'ru',
          category: 'safe-context',
          expectedAction: 'NO_ACTION',
          caption: '',
          images: [{ path: 'safe.png', sha256: 'a'.repeat(64) }],
        },
      ],
    };

    expect(commercialOcrEvalManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [...manifest.cases, manifest.cases[0]],
      }),
    ).toThrow(/duplicate id/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          ...manifest.cases,
          { ...manifest.cases[0], id: 'unsafe-1', expectedAction: 'DELETE' },
        ],
      }),
    ).toThrow(/cluster contains conflicting expected actions/u);
    expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\//u);
  });

  it('accepts legacy v1 cases while validating optional enforcement metadata', () => {
    const legacy = validManifest();
    expect(commercialOcrEvalManifestSchema.parse(legacy)).toEqual(legacy);

    const labeled = {
      ...legacy,
      cases: [
        {
          ...legacy.cases[0],
          imageTextScript: 'cyrillic_only',
          captionLanguage: 'none',
          hardNegativeCategory: 'rules_or_moderation_context',
        },
      ],
    };
    expect(commercialOcrEvalManifestSchema.parse(labeled)).toEqual(labeled);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...labeled,
        cases: [{ ...labeled.cases[0], expectedAction: 'DELETE' }],
      }),
    ).toThrow(/hard-negative category requires NO_ACTION/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...labeled,
        cases: [{ ...labeled.cases[0], caption: 'Текст', captionLanguage: 'none' }],
      }),
    ).toThrow(/non-empty caption cannot use none language/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...labeled,
        cases: [{ ...labeled.cases[0], captionLanguage: 'ru' }],
      }),
    ).toThrow(/empty caption requires none language/u);
  });

  it('requires complete v2 annotations and prevents cluster leakage across splits', () => {
    const manifest = validV2Manifest();
    expect(commercialOcrEvalManifestSchema.parse(manifest)).toEqual(manifest);

    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [...manifest.cases, { ...manifest.cases[0], id: 'case-2', split: 'development' }],
      }),
    ).toThrow(/cluster crosses corpus splits/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...manifest.cases[0],
            expectations: [
              {
                ...manifest.cases[0].expectations[0],
                settingsProfileId: 'missing-profile',
              },
            ],
          },
        ],
      }),
    ).toThrow(/unknown settings profile id/u);
  });

  it('requires complete v2 provenance and distinct collection and adjudication artifacts', () => {
    const manifest = validV2Manifest();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        provenance: { ...manifest.provenance, collectionProtocolVersion: undefined },
      }),
    ).toThrow(/collectionProtocolVersion/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        provenance: { ...manifest.provenance, collectionArtifact: undefined },
      }),
    ).toThrow(/collectionArtifact/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        provenance: { ...manifest.provenance, adjudicationArtifact: undefined },
      }),
    ).toThrow(/adjudicationArtifact/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        provenance: {
          ...manifest.provenance,
          adjudicationArtifact: {
            ...manifest.provenance.adjudicationArtifact,
            path: manifest.provenance.collectionArtifact.path,
          },
        },
      }),
    ).toThrow(/provenance artifacts must be distinct/u);
  });

  it('requires independent reviewer evidence and consensus for the complete adjudicated decision', () => {
    const manifest = validV2Manifest();
    const fixture = manifest.cases[0]!;
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...fixture,
            annotation: {
              ...fixture.annotation,
              reviewerDecisions: fixture.annotation.reviewerDecisions.map((decision) => ({
                ...decision,
                evidenceSha256: 'e'.repeat(64),
              })),
            },
          },
        ],
      }),
    ).toThrow(/evidence digests must be unique/u);

    const dissentingDecision = {
      ...fixture.annotation.reviewerDecisions[1]!,
      commercialSubtype: null,
      expectations: fixture.expectations.map((expectation) => ({
        ...expectation,
        expectedCommercialAction: 'NO_ACTION' as const,
        expectedEnforcementAction: 'NO_ACTION' as const,
      })),
    };
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...fixture,
            annotation: {
              ...fixture.annotation,
              reviewerDecisions: [fixture.annotation.reviewerDecisions[0]!, dissentingDecision],
            },
          },
        ],
      }),
    ).toThrow(/complete adjudicated decision/u);
  });

  it('accepts a genuine three-reviewer tie-breaker majority', () => {
    const manifest = validV2Manifest();
    const fixture = manifest.cases[0]!;
    const dissentingExpectations = fixture.expectations.map((expectation) => ({
      ...expectation,
      expectedCommercialAction: 'NO_ACTION' as const,
      expectedEnforcementAction: 'NO_ACTION' as const,
    }));
    const tieBreakerCase = {
      ...fixture,
      annotation: {
        ...fixture.annotation,
        annotatorIds: ['reviewer-a', 'reviewer-b', 'reviewer-c'],
        adjudication: 'tie_breaker' as const,
        reviewerDecisions: [
          fixture.annotation.reviewerDecisions[0]!,
          {
            reviewerId: 'reviewer-b',
            evidenceSha256: 'f'.repeat(64),
            commercialSubtype: null,
            expectations: dissentingExpectations,
          },
          {
            reviewerId: 'reviewer-c',
            evidenceSha256: '9'.repeat(64),
            commercialSubtype: 'SERVICES' as const,
            expectations: fixture.expectations,
          },
        ],
      },
    };

    expect(() =>
      commercialOcrEvalManifestSchema.parse({ ...manifest, cases: [tieBreakerCase] }),
    ).not.toThrow();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...tieBreakerCase,
            annotation: {
              ...tieBreakerCase.annotation,
              reviewerDecisions: tieBreakerCase.annotation.reviewerDecisions.map(
                (decision, index) =>
                  index === 1
                    ? {
                        ...fixture.annotation.reviewerDecisions[1]!,
                        reviewerId: 'reviewer-b',
                      }
                    : decision,
              ),
            },
          },
        ],
      }),
    ).toThrow(/recorded reviewer disagreement/u);
  });

  it('rejects a fragmented tie-breaker majority with no two complete matching decisions', () => {
    const manifest = validV2Manifest();
    const fixture = manifest.cases[0]!;
    const strictProfile = {
      id: 'strict-45-75',
      commercialAdsSensitivity: 'STRICT' as const,
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 75,
    };
    const adjudicatedExpectations = [
      ...fixture.expectations,
      {
        settingsProfileId: strictProfile.id,
        expectedCommercialAction: 'DELETE' as const,
        expectedEnforcementAction: 'DELETE' as const,
      },
    ];
    const noAction = (settingsProfileId: string): TestExpectation => ({
      settingsProfileId,
      expectedCommercialAction: 'NO_ACTION',
      expectedEnforcementAction: 'NO_ACTION',
    });

    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        settingsProfiles: [...manifest.settingsProfiles, strictProfile],
        cases: [
          {
            ...fixture,
            expectations: adjudicatedExpectations,
            annotation: {
              ...fixture.annotation,
              annotatorIds: ['reviewer-a', 'reviewer-b', 'reviewer-c'],
              adjudication: 'tie_breaker',
              reviewerDecisions: [
                {
                  reviewerId: 'reviewer-a',
                  evidenceSha256: 'e'.repeat(64),
                  commercialSubtype: 'SERVICES',
                  expectations: [fixture.expectations[0]!, noAction(strictProfile.id)],
                },
                {
                  reviewerId: 'reviewer-b',
                  evidenceSha256: 'f'.repeat(64),
                  commercialSubtype: 'SERVICES',
                  expectations: adjudicatedExpectations,
                },
                {
                  reviewerId: 'reviewer-c',
                  evidenceSha256: '9'.repeat(64),
                  commercialSubtype: 'SERVICES',
                  expectations: [
                    noAction(fixture.expectations[0]!.settingsProfileId),
                    adjudicatedExpectations[1]!,
                  ],
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/complete adjudicated decision/u);
  });

  it('allows counterfactual labels inside one v2 cluster when the split is unchanged', () => {
    const manifest = validV2Manifest();
    const counterfactualExpectations = [
      {
        settingsProfileId: 'balanced-45-65',
        expectedCommercialAction: 'NO_ACTION' as const,
        expectedEnforcementAction: 'NO_ACTION' as const,
      },
    ];
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          manifest.cases[0],
          {
            ...manifest.cases[0],
            id: 'counterfactual-2',
            statisticsRepresentative: false,
            commercialSubtype: undefined,
            expectations: counterfactualExpectations,
            annotation: {
              ...manifest.cases[0].annotation,
              reviewerDecisions: reviewerDecisionsFor(counterfactualExpectations, null),
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('requires each holdout representative to cover every settings profile', () => {
    const manifest = validV2Manifest();
    const strictProfile = {
      id: 'strict-45-75',
      commercialAdsSensitivity: 'STRICT' as const,
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 75,
    };
    const expectations = [
      ...manifest.cases[0]!.expectations,
      {
        settingsProfileId: 'strict-45-75',
        expectedCommercialAction: 'DELETE' as const,
        expectedEnforcementAction: 'DELETE' as const,
      },
    ];
    const withEveryProfile = {
      ...manifest,
      settingsProfiles: [...manifest.settingsProfiles, strictProfile],
      cases: [
        {
          ...manifest.cases[0],
          expectations,
          annotation: {
            ...manifest.cases[0].annotation,
            reviewerDecisions: reviewerDecisionsFor(expectations, 'SERVICES'),
          },
        },
      ],
    };

    expect(() => commercialOcrEvalManifestSchema.parse(withEveryProfile)).not.toThrow();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...withEveryProfile,
        cases: [
          {
            ...withEveryProfile.cases[0],
            expectations: manifest.cases[0]!.expectations,
          },
        ],
      }),
    ).toThrow(/statistics representative requires expectations for every settings profile/u);
  });

  it('requires each adversarial case to cover every settings profile', () => {
    const manifest = validV2Manifest();
    const strictProfile = {
      id: 'strict-45-75',
      commercialAdsSensitivity: 'STRICT' as const,
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 75,
    };
    const adversarialCase = {
      ...manifest.cases[0],
      id: 'adversarial-case-1',
      clusterId: 'adversarial-cluster-1',
      split: 'adversarial' as const,
      statisticsRepresentative: false,
      images: [{ ...manifest.cases[0]!.images[0], sha256: 'b'.repeat(64) }],
    };

    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        settingsProfiles: [...manifest.settingsProfiles, strictProfile],
        cases: [adversarialCase],
      }),
    ).toThrow(/adversarial case requires expectations for every settings profile/u);
    const completeExpectations = [
      ...adversarialCase.expectations,
      {
        settingsProfileId: strictProfile.id,
        expectedCommercialAction: 'DELETE' as const,
        expectedEnforcementAction: 'DELETE' as const,
      },
    ];
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        settingsProfiles: [...manifest.settingsProfiles, strictProfile],
        cases: [
          {
            ...adversarialCase,
            expectations: completeExpectations,
            annotation: {
              ...adversarialCase.annotation,
              reviewerDecisions: reviewerDecisionsFor(completeExpectations, 'SERVICES'),
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('prevents image leakage across splits even when case and cluster ids differ', () => {
    const manifest = validV2Manifest();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          manifest.cases[0],
          {
            ...manifest.cases[0],
            id: 'development-case-2',
            clusterId: 'development-cluster-2',
            split: 'development',
            statisticsRepresentative: false,
          },
        ],
      }),
    ).toThrow(/image digest crosses corpus splits/u);
  });

  it('does not count one image digest as evidence from independent clusters', () => {
    const manifest = validV2Manifest();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          manifest.cases[0],
          {
            ...manifest.cases[0],
            id: 'holdout-case-2',
            clusterId: 'holdout-cluster-2',
          },
        ],
      }),
    ).toThrow(/image digest crosses independent clusters/u);
  });

  it('rejects inconsistent transcripts, settings, and decision expectations', () => {
    const manifest = validV2Manifest();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...manifest.cases[0],
            images: [
              {
                ...manifest.cases[0]!.images[0],
                imageTextScript: 'latin_only',
              },
            ],
          },
        ],
      }),
    ).toThrow(/image text script does not match the annotated transcript/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        settingsProfiles: [
          ...manifest.settingsProfiles,
          { ...manifest.settingsProfiles[0], id: 'same-behavior' },
        ],
      }),
    ).toThrow(/must not duplicate an existing behavior configuration/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...manifest.cases[0],
            expectations: [
              {
                settingsProfileId: 'balanced-45-65',
                expectedCommercialAction: 'NO_ACTION',
                expectedEnforcementAction: 'DELETE',
              },
            ],
          },
        ],
      }),
    ).toThrow(/DELETE enforcement requires a DELETE commercial decision/u);
  });

  it('normalizes critical tokens without joining unrelated numeric spans', () => {
    const phone = { kind: 'phone' as const, value: '+7 (999) 123-45-67' };
    expect(normalizeCommercialOcrEvalCriticalToken(phone)).toBe('79991234567');
    expect(criticalTokenAppearsInTranscript(phone, 'Запись: +7 999 123 45 67, ежедневно.')).toBe(
      true,
    );
    expect(
      criticalTokenAppearsInTranscript(
        { kind: 'phone', value: '7999' },
        'В наличии 7 товаров, на складе осталось 999.',
      ),
    ).toBe(false);
    expect(
      criticalTokenAppearsInTranscript(
        { kind: 'price', value: '1 200 руб.' },
        'Стоимость 1 200 руб.',
      ),
    ).toBe(true);
    expect(
      criticalTokenAppearsInTranscript(
        { kind: 'price', value: '200 руб.' },
        'Стоимость 1 200 руб.',
      ),
    ).toBe(false);
    expect(criticalTokenAppearsInTranscript(phone, 'Запись: 8 999 123 45 67, ежедневно.')).toBe(
      true,
    );
    expect(
      criticalTokenAppearsInTranscript(
        { kind: 'commercial_anchor', value: 'ремонт' },
        'Опытный ремонтник ответит на вопросы.',
      ),
    ).toBe(false);
    expect(
      criticalTokenAppearsInTranscript(
        { kind: 'domain', value: 'https://www.Example.RU' },
        'Подробности на example.ru',
      ),
    ).toBe(true);
  });

  it('requires every normalized critical token to occur in its image transcript', () => {
    const manifest = validV2Manifest();
    const fixture = manifest.cases[0]!;
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...fixture,
            images: [
              {
                ...fixture.images[0]!,
                criticalTokens: [
                  fixture.images[0]!.criticalTokens[0]!,
                  { kind: 'phone', value: '+7 000 000 00 00' },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/critical token value must be present/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...fixture,
            images: [
              {
                ...fixture.images[0]!,
                criticalTokens: [
                  ...fixture.images[0]!.criticalTokens,
                  { kind: 'phone', value: '+7 (999) 123-45-67' },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/critical tokens must be unique/u);
  });

  it('models the runtime enforcement language surface for album images', () => {
    const manifest = validV2Manifest();
    const secondary = {
      ...manifest.cases[0]!.images[0],
      path: 'secondary.png',
      sha256: 'b'.repeat(64),
      imageTextScript: 'unknown' as const,
      transcript: '123 456',
      criticalTokens: [],
    };
    const withoutLatinSecondary = {
      ...manifest,
      cases: [{ ...manifest.cases[0], images: [...manifest.cases[0]!.images, secondary] }],
    };

    expect(() => commercialOcrEvalManifestSchema.parse(withoutLatinSecondary)).not.toThrow();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...withoutLatinSecondary,
        cases: [
          {
            ...withoutLatinSecondary.cases[0],
            images: [
              ...manifest.cases[0]!.images,
              {
                ...secondary,
                imageTextScript: 'latin_only',
                transcript: 'sale',
              },
            ],
          },
        ],
      }),
    ).toThrow(/no Latin image transcript/u);
  });

  it('rejects enforcement labels below the runtime Cyrillic letter threshold', () => {
    const manifest = validV2Manifest();
    const transcript = 'я'.repeat(COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS - 1);

    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...manifest.cases[0],
            images: [
              {
                ...manifest.cases[0]!.images[0],
                transcript,
                criticalTokens: [
                  { kind: 'commercial_anchor', value: transcript },
                  { kind: 'phone', value: '+79991234567' },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(
      new RegExp(
        `at least ${COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS} Cyrillic letters`,
        'u',
      ),
    );
  });

  it('does not label Cyrillic mixed with another non-Latin script as Cyrillic-only', () => {
    const manifest = validV2Manifest();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...manifest.cases[0],
            images: [
              {
                ...manifest.cases[0]!.images[0],
                transcript: 'Ремонт окон خدمة +7 999 123 45 67',
              },
            ],
          },
        ],
      }),
    ).toThrow(/image text script does not match/u);
  });

  it('requires annotation and temporal source provenance to precede corpus freeze', () => {
    const manifest = validV2Manifest();
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...manifest.cases[0],
            annotation: {
              ...manifest.cases[0]!.annotation,
              reviewedAt: '2026-08-11T00:00:00.000Z',
            },
          },
        ],
      }),
    ).toThrow(/annotation review must not be later than corpus freeze time/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          {
            ...manifest.cases[0],
            annotation: {
              ...manifest.cases[0]!.annotation,
              reviewedAt: '2026-07-31T23:59:59.000Z',
            },
          },
        ],
      }),
    ).toThrow(/annotation review must not predate the production source window/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        provenance: {
          ...manifest.provenance,
          windowEndedAt: '2026-08-11T00:00:00.000Z',
        },
      }),
    ).toThrow(/ordered source window before freeze/u);
  });

  it('refuses traversal and digest drift before evaluation', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('fixture', 'utf8'),
    ]);
    await writeFile(join(root, 'fixture.png'), bytes);

    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: {
          path: 'fixture.png',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        maxBytes: 100,
      }),
    ).resolves.toEqual(bytes);
    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: '../fixture.png', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/escapes/u);
    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: 'fixture.png', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/digest mismatch/u);
  });

  it('rejects a digest-valid format that runtime photo download does not accept', async () => {
    const root = await temporaryRoot();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    await writeFile(join(root, 'fixture.svg'), svg);

    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: {
          path: 'fixture.svg',
          sha256: createHash('sha256').update(svg).digest('hex'),
        },
        maxBytes: 1_024,
      }),
    ).rejects.toThrow(/unsupported image signature/u);
  });

  it('rejects oversized files from metadata and symlinks that escape the canonical corpus root', async () => {
    const root = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    const oversizedPath = join(root, 'oversized.bin');
    const outsidePath = join(outsideRoot, 'outside.bin');
    await writeFile(oversizedPath, 'x');
    await truncate(oversizedPath, 101);
    await writeFile(outsidePath, 'outside');
    await symlink(outsidePath, join(root, 'linked.bin'));

    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: 'oversized.bin', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/size/u);
    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: 'linked.bin', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/symlink escapes/u);
  });

  it('stats an oversized manifest before reading its contents', async () => {
    const root = await temporaryRoot();
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, '{}');
    await truncate(manifestPath, 16 * 1024 * 1024 + 1);

    await expect(loadCommercialOcrEvalManifest(manifestPath)).rejects.toThrow(/size/u);
  });

  it('verifies both v2 provenance artifact digests before returning the manifest', async () => {
    const root = await temporaryRoot();
    const collectionBytes = Buffer.from('collection evidence\n', 'utf8');
    const adjudicationBytes = Buffer.from('adjudication evidence\n', 'utf8');
    const manifest = validV2Manifest();
    const verifiedManifest = {
      ...manifest,
      provenance: {
        ...manifest.provenance,
        collectionArtifact: {
          path: 'collection-evidence.jsonl',
          sha256: createHash('sha256').update(collectionBytes).digest('hex'),
        },
        adjudicationArtifact: {
          path: 'adjudication-evidence.jsonl',
          sha256: createHash('sha256').update(adjudicationBytes).digest('hex'),
        },
      },
    };
    const manifestPath = join(root, 'manifest.json');
    const manifestBytes = JSON.stringify(verifiedManifest);
    await Promise.all([
      writeFile(join(root, 'collection-evidence.jsonl'), collectionBytes),
      writeFile(join(root, 'adjudication-evidence.jsonl'), adjudicationBytes),
      writeFile(manifestPath, manifestBytes),
    ]);

    await expect(loadCommercialOcrEvalManifest(manifestPath)).resolves.toMatchObject({
      manifest: verifiedManifest,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      corpusRoot: root,
    });
    await writeFile(join(root, 'collection-evidence.jsonl'), 'tampered collection\n');
    await expect(loadCommercialOcrEvalManifest(manifestPath)).rejects.toThrow(
      /collection provenance artifact digest mismatch/u,
    );
    await writeFile(join(root, 'collection-evidence.jsonl'), collectionBytes);
    await writeFile(join(root, 'adjudication-evidence.jsonl'), 'tampered adjudication\n');
    await expect(loadCommercialOcrEvalManifest(manifestPath)).rejects.toThrow(
      /adjudication provenance artifact digest mismatch/u,
    );
  });

  it('rejects provenance artifact paths that escape the corpus root', async () => {
    const root = await temporaryRoot();
    const manifest = validV2Manifest();
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        provenance: {
          ...manifest.provenance,
          collectionArtifact: {
            ...manifest.provenance.collectionArtifact,
            path: '../collection-evidence.jsonl',
          },
        },
      }),
    );

    await expect(loadCommercialOcrEvalManifest(join(root, 'manifest.json'))).rejects.toThrow(
      /path escapes the corpus root/u,
    );
  });

  it('requires an in-repository private corpus directory to be explicitly ignored', async () => {
    const repositoryRoot = await temporaryRoot();
    await execFileAsync('git', ['init', '--quiet'], { cwd: repositoryRoot });
    const publicRoot = join(repositoryRoot, 'public-corpus');
    const privateRoot = join(repositoryRoot, 'private-corpus');
    const trackedRoot = join(repositoryRoot, 'tracked-corpus');
    await Promise.all([mkdir(publicRoot), mkdir(privateRoot), mkdir(trackedRoot)]);
    await writeFile(join(repositoryRoot, '.gitignore'), 'private-corpus/\ntracked-corpus/\n');
    const manifest = JSON.stringify(validManifest());
    await Promise.all([
      writeFile(join(publicRoot, 'manifest.json'), manifest),
      writeFile(join(privateRoot, 'manifest.json'), manifest),
      writeFile(join(trackedRoot, 'manifest.json'), manifest),
    ]);
    await execFileAsync('git', ['add', '--force', 'tracked-corpus/manifest.json'], {
      cwd: repositoryRoot,
    });

    await expect(loadCommercialOcrEvalManifest(join(publicRoot, 'manifest.json'))).rejects.toThrow(
      /outside Git or under an ignored directory/u,
    );
    await expect(
      loadCommercialOcrEvalManifest(join(privateRoot, 'manifest.json')),
    ).resolves.toMatchObject({ manifest: validManifest(), corpusRoot: privateRoot });
    await expect(loadCommercialOcrEvalManifest(join(trackedRoot, 'manifest.json'))).rejects.toThrow(
      /Git-tracked files/u,
    );
  });

  it('fails closed when Git privacy verification itself is broken', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, '.git'), 'not a valid gitfile');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(validManifest()));

    await expect(loadCommercialOcrEvalManifest(join(root, 'manifest.json'))).rejects.toThrow(
      /Unable to verify/u,
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'commercial-ocr-eval-'));
  temporaryRoots.push(root);
  return root;
}

function validManifest() {
  return {
    schemaVersion: 1 as const,
    corpusId: 'private-eval',
    corpusRevision: 'v1',
    cases: [
      {
        id: 'case-1',
        clusterId: 'cluster-1',
        language: 'ru' as const,
        category: 'test',
        expectedAction: 'NO_ACTION' as const,
        caption: '',
        images: [{ path: 'fixture.bin', sha256: 'a'.repeat(64) }],
      },
    ],
  };
}

type TestExpectation = {
  settingsProfileId: string;
  expectedCommercialAction: 'DELETE' | 'NO_ACTION';
  expectedEnforcementAction: 'DELETE' | 'NO_ACTION';
};

function reviewerDecisionsFor(
  expectations: readonly TestExpectation[],
  commercialSubtype: 'SERVICES' | null,
) {
  return [
    {
      reviewerId: 'reviewer-a',
      evidenceSha256: 'e'.repeat(64),
      commercialSubtype,
      expectations: expectations.map((expectation) => ({ ...expectation })),
    },
    {
      reviewerId: 'reviewer-b',
      evidenceSha256: 'f'.repeat(64),
      commercialSubtype,
      expectations: expectations.map((expectation) => ({ ...expectation })),
    },
  ];
}

function validV2Manifest() {
  return {
    schemaVersion: 2 as const,
    corpusId: 'private-v2-eval',
    corpusRevision: '2026-08-holdout-1',
    provenance: {
      sourceKind: 'production_temporal' as const,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      windowEndedAt: '2026-08-08T00:00:00.000Z',
      frozenAt: '2026-08-10T00:00:00.000Z',
      collectionProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
      annotationProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
      collectionArtifact: {
        path: 'collection-evidence.jsonl',
        sha256: 'c'.repeat(64),
      },
      adjudicationArtifact: {
        path: 'adjudication-evidence.jsonl',
        sha256: 'd'.repeat(64),
      },
    },
    settingsProfiles: [
      {
        id: 'balanced-45-65',
        commercialAdsSensitivity: 'BALANCED' as const,
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    ],
    cases: [
      {
        id: 'case-1',
        clusterId: 'cluster-1',
        split: 'holdout' as const,
        language: 'ru' as const,
        captionLanguage: 'none' as const,
        category: 'services',
        commercialSubtype: 'SERVICES' as const,
        statisticsRepresentative: true,
        expectations: [
          {
            settingsProfileId: 'balanced-45-65',
            expectedCommercialAction: 'DELETE' as const,
            expectedEnforcementAction: 'DELETE' as const,
          },
        ],
        caption: '',
        annotation: {
          annotatorIds: ['reviewer-a', 'reviewer-b'],
          adjudication: 'agreement' as const,
          reviewedAt: '2026-08-09T00:00:00.000Z',
          reviewerDecisions: [
            {
              reviewerId: 'reviewer-a',
              evidenceSha256: 'e'.repeat(64),
              commercialSubtype: 'SERVICES' as const,
              expectations: [
                {
                  settingsProfileId: 'balanced-45-65',
                  expectedCommercialAction: 'DELETE' as const,
                  expectedEnforcementAction: 'DELETE' as const,
                },
              ],
            },
            {
              reviewerId: 'reviewer-b',
              evidenceSha256: 'f'.repeat(64),
              commercialSubtype: 'SERVICES' as const,
              expectations: [
                {
                  settingsProfileId: 'balanced-45-65',
                  expectedCommercialAction: 'DELETE' as const,
                  expectedEnforcementAction: 'DELETE' as const,
                },
              ],
            },
          ],
        },
        images: [
          {
            path: 'fixture.bin',
            sha256: 'a'.repeat(64),
            source: 'direct' as const,
            imageTextScript: 'cyrillic_only' as const,
            transcript: 'Ремонт окон, звоните +7 999 123 45 67',
            visualConditions: ['clean' as const],
            criticalTokens: [
              { kind: 'commercial_anchor' as const, value: 'ремонт' },
              { kind: 'phone' as const, value: '+79991234567' },
            ],
          },
        ],
      },
    ],
  };
}
