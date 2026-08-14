import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import { detectSupportedPhotoImageFormat } from '../../photo-duplicate/photo-image-format';
import { COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS } from '../commercial-ocr-decision-policy';
import { classifyCommercialOcrLetterScript } from '../commercial-ocr-letter-script';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_EVAL_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PROVENANCE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export const COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION =
  'production-temporal-random-v1' as const;
export const COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION =
  'ocr-adjudication-v2' as const;

const verifiedPrivateRoots = new Map<string, Promise<void>>();

const imageDigestSchema = z
  .object({
    path: z.string().min(1).max(512),
    sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const imageTextScriptSchema = z.enum(['cyrillic_only', 'latin_only', 'mixed', 'unknown']);
const captionLanguageSchema = z.enum(['none', 'ru', 'en', 'mixed', 'other', 'unknown']);
const expectedActionSchema = z.enum(['DELETE', 'NO_ACTION']);
const provenanceArtifactSchema = z
  .object({
    path: z.string().min(1).max(512),
    sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

export const commercialOcrEvalCaseV1Schema = z
  .object({
    id: z.string().regex(OPAQUE_ID_PATTERN),
    clusterId: z.string().regex(OPAQUE_ID_PATTERN),
    language: z.enum(['ru', 'en', 'mixed']),
    imageTextScript: imageTextScriptSchema.optional(),
    captionLanguage: captionLanguageSchema.optional(),
    category: z.string().regex(OPAQUE_ID_PATTERN),
    hardNegativeCategory: z.string().regex(OPAQUE_ID_PATTERN).optional(),
    expectedAction: expectedActionSchema,
    caption: z.string().max(8_000).default(''),
    images: z.array(imageDigestSchema).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hardNegativeCategory && value.expectedAction !== 'NO_ACTION') {
      context.addIssue({
        code: 'custom',
        path: ['hardNegativeCategory'],
        message: 'hard-negative category requires NO_ACTION',
      });
    }

    if (value.captionLanguage === undefined) {
      return;
    }
    const hasCaption = value.caption.trim().length > 0;
    if (hasCaption && value.captionLanguage === 'none') {
      context.addIssue({
        code: 'custom',
        path: ['captionLanguage'],
        message: 'non-empty caption cannot use none language',
      });
    }
    if (!hasCaption && value.captionLanguage !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['captionLanguage'],
        message: 'empty caption requires none language',
      });
    }
  });

const visualConditionSchema = z.enum([
  'clean',
  'low_resolution',
  'small_text',
  'compression',
  'blur',
  'low_contrast',
  'high_contrast',
  'rotated',
  'perspective',
  'multi_column',
  'textured_background',
  'inverted',
  'mixed_fonts',
  'occluded',
]);

const criticalTokenKindSchema = z.enum([
  'commercial_anchor',
  'phone',
  'price',
  'domain',
  'handle',
  'transaction',
]);
type CriticalTokenKind = z.infer<typeof criticalTokenKindSchema>;

const DEAL_CRITICAL_TOKEN_KINDS: ReadonlySet<CriticalTokenKind> = new Set([
  'phone',
  'price',
  'domain',
  'handle',
  'transaction',
]);

const criticalTokenSchema = z
  .object({
    kind: criticalTokenKindSchema,
    value: z.string().min(1).max(512),
  })
  .strict();

const commercialSubtypeSchema = z.enum([
  'CHANNEL_PLACEMENT',
  'PROPERTY_AGENT',
  'PROPERTY_COMMERCIAL',
  'RECRUITMENT',
  'INFO_PRODUCT',
  'BUYOUT',
  'SERVICES',
  'GOODS_RETAIL',
  'GOODS',
  'GROUP_PROMOTION',
  'GENERIC',
]);

const settingsExpectationSchema = z
  .object({
    settingsProfileId: z.string().regex(OPAQUE_ID_PATTERN),
    expectedCommercialAction: expectedActionSchema,
    expectedEnforcementAction: expectedActionSchema,
  })
  .strict();

const reviewerDecisionSchema = z
  .object({
    reviewerId: z.string().regex(OPAQUE_ID_PATTERN),
    evidenceSha256: z.string().regex(SHA256_PATTERN),
    commercialSubtype: commercialSubtypeSchema.nullable(),
    expectations: z.array(settingsExpectationSchema).min(1).max(32),
  })
  .strict();

export const commercialOcrEvalCaseV2Schema = z
  .object({
    id: z.string().regex(OPAQUE_ID_PATTERN),
    clusterId: z.string().regex(OPAQUE_ID_PATTERN),
    split: z.enum(['development', 'holdout', 'adversarial']),
    language: z.enum(['ru', 'en', 'mixed']),
    captionLanguage: captionLanguageSchema,
    category: z.string().regex(OPAQUE_ID_PATTERN),
    hardNegativeCategory: z.string().regex(OPAQUE_ID_PATTERN).optional(),
    commercialSubtype: commercialSubtypeSchema.optional(),
    statisticsRepresentative: z.boolean(),
    expectations: z.array(settingsExpectationSchema).min(1).max(32),
    caption: z.string().max(8_000).default(''),
    annotation: z
      .object({
        annotatorIds: z.array(z.string().regex(OPAQUE_ID_PATTERN)).min(2).max(3),
        adjudication: z.enum(['agreement', 'tie_breaker']),
        reviewedAt: z.string().datetime({ offset: true }),
        reviewerDecisions: z.array(reviewerDecisionSchema).min(2).max(3),
      })
      .strict(),
    images: z
      .array(
        imageDigestSchema.extend({
          source: z.enum(['direct', 'forward']).default('direct'),
          imageTextScript: imageTextScriptSchema,
          transcript: z.string().max(32_000),
          visualConditions: z.array(visualConditionSchema).min(1).max(16),
          criticalTokens: z.array(criticalTokenSchema).max(128),
        }),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const expectationProfileIds = value.expectations.map((item) => item.settingsProfileId);
    if (new Set(expectationProfileIds).size !== expectationProfileIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['expectations'],
        message: 'expectation settings profile ids must be unique',
      });
    }
    if (new Set(value.annotation.annotatorIds).size !== value.annotation.annotatorIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'annotatorIds'],
        message: 'annotator ids must be unique',
      });
    }
    const reviewerIds = value.annotation.reviewerDecisions.map((item) => item.reviewerId);
    if (
      new Set(reviewerIds).size !== reviewerIds.length ||
      reviewerIds.length !== value.annotation.annotatorIds.length ||
      [...reviewerIds].sort().join('\0') !== [...value.annotation.annotatorIds].sort().join('\0')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'reviewerDecisions'],
        message: 'reviewer decisions must contain exactly one decision for every annotator',
      });
    }
    if (
      new Set(value.annotation.reviewerDecisions.map((item) => item.evidenceSha256)).size !==
      value.annotation.reviewerDecisions.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'reviewerDecisions'],
        message: 'reviewer decision evidence digests must be unique',
      });
    }
    const sortedExpectationProfileIds = [...expectationProfileIds].sort().join('\0');
    for (
      let decisionIndex = 0;
      decisionIndex < value.annotation.reviewerDecisions.length;
      decisionIndex += 1
    ) {
      const decision = value.annotation.reviewerDecisions[decisionIndex]!;
      const decisionProfileIds = decision.expectations.map((item) => item.settingsProfileId);
      if (
        new Set(decisionProfileIds).size !== decisionProfileIds.length ||
        [...decisionProfileIds].sort().join('\0') !== sortedExpectationProfileIds
      ) {
        context.addIssue({
          code: 'custom',
          path: ['annotation', 'reviewerDecisions', decisionIndex, 'expectations'],
          message: 'each reviewer decision must cover every case settings profile exactly once',
        });
      }
      if (
        decision.expectations.some(
          (item) =>
            item.expectedEnforcementAction === 'DELETE' &&
            item.expectedCommercialAction !== 'DELETE',
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['annotation', 'reviewerDecisions', decisionIndex, 'expectations'],
          message: 'reviewer DELETE enforcement requires a DELETE commercial decision',
        });
      }
    }
    const requiredConsensus =
      value.annotation.adjudication === 'agreement' ? value.annotation.reviewerDecisions.length : 2;
    for (
      let expectationIndex = 0;
      expectationIndex < value.expectations.length;
      expectationIndex += 1
    ) {
      const expectation = value.expectations[expectationIndex]!;
      const matchingReviewers = value.annotation.reviewerDecisions.filter((decision) => {
        const reviewerExpectation = decision.expectations.find(
          (item) => item.settingsProfileId === expectation.settingsProfileId,
        );
        return (
          reviewerExpectation?.expectedCommercialAction === expectation.expectedCommercialAction &&
          reviewerExpectation.expectedEnforcementAction === expectation.expectedEnforcementAction
        );
      }).length;
      if (matchingReviewers < requiredConsensus) {
        context.addIssue({
          code: 'custom',
          path: ['annotation', 'reviewerDecisions'],
          message: `reviewer decisions do not support the adjudicated expectation for ${expectation.settingsProfileId}`,
        });
      }
    }
    const adjudicatedDecisionKey = canonicalReviewerDecision({
      commercialSubtype: value.commercialSubtype ?? null,
      expectations: value.expectations,
    });
    const matchingAdjudicatedDecisions = value.annotation.reviewerDecisions.filter(
      (decision) => canonicalReviewerDecision(decision) === adjudicatedDecisionKey,
    ).length;
    if (matchingAdjudicatedDecisions < requiredConsensus) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'reviewerDecisions'],
        message: 'reviewer consensus must support the complete adjudicated decision',
      });
    }
    const adjudicatedSubtype = value.commercialSubtype ?? null;
    if (
      value.annotation.reviewerDecisions.filter(
        (decision) => decision.commercialSubtype === adjudicatedSubtype,
      ).length < requiredConsensus
    ) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'reviewerDecisions'],
        message: 'reviewer decisions do not support the adjudicated commercial subtype',
      });
    }
    if (
      value.annotation.adjudication === 'tie_breaker' &&
      value.annotation.annotatorIds.length < 3
    ) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'annotatorIds'],
        message: 'tie-breaker adjudication requires three annotators',
      });
    }
    if (
      value.annotation.adjudication === 'tie_breaker' &&
      matchingAdjudicatedDecisions === value.annotation.reviewerDecisions.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'adjudication'],
        message: 'tie-breaker adjudication requires a recorded reviewer disagreement',
      });
    }
    if (
      value.hardNegativeCategory &&
      value.expectations.some(
        (item) =>
          item.expectedCommercialAction !== 'NO_ACTION' ||
          item.expectedEnforcementAction !== 'NO_ACTION',
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['hardNegativeCategory'],
        message: 'hard-negative category requires NO_ACTION commercial and enforcement actions',
      });
    }
    for (
      let expectationIndex = 0;
      expectationIndex < value.expectations.length;
      expectationIndex += 1
    ) {
      const expectation = value.expectations[expectationIndex]!;
      if (
        expectation.expectedEnforcementAction === 'DELETE' &&
        expectation.expectedCommercialAction !== 'DELETE'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['expectations', expectationIndex, 'expectedEnforcementAction'],
          message: 'DELETE enforcement requires a DELETE commercial decision',
        });
      }
    }
    const expectsCommercialDelete = value.expectations.some(
      (item) => item.expectedCommercialAction === 'DELETE',
    );
    const expectsEnforcementDelete = value.expectations.some(
      (item) => item.expectedEnforcementAction === 'DELETE',
    );
    if (expectsCommercialDelete && !value.commercialSubtype) {
      context.addIssue({
        code: 'custom',
        path: ['commercialSubtype'],
        message: 'commercial DELETE expectations require a commercial subtype',
      });
    }
    if (!expectsCommercialDelete && value.commercialSubtype) {
      context.addIssue({
        code: 'custom',
        path: ['commercialSubtype'],
        message: 'commercial subtype requires a commercial DELETE expectation',
      });
    }
    for (
      let decisionIndex = 0;
      decisionIndex < value.annotation.reviewerDecisions.length;
      decisionIndex += 1
    ) {
      const decision = value.annotation.reviewerDecisions[decisionIndex]!;
      const reviewerExpectsCommercialDelete = decision.expectations.some(
        (item) => item.expectedCommercialAction === 'DELETE',
      );
      if (reviewerExpectsCommercialDelete !== (decision.commercialSubtype !== null)) {
        context.addIssue({
          code: 'custom',
          path: ['annotation', 'reviewerDecisions', decisionIndex, 'commercialSubtype'],
          message:
            'reviewer commercial subtype must be present exactly when the reviewer expects commercial DELETE',
        });
      }
    }
    const hasEnforcementCandidate = value.images.some((image) => {
      const kinds = new Set(image.criticalTokens.map((token) => token.kind));
      const script = classifyCommercialOcrLetterScript(image.transcript);
      return (
        image.imageTextScript === 'cyrillic_only' &&
        script.cyrillicLetterCount >= COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS &&
        kinds.has('commercial_anchor') &&
        [...DEAL_CRITICAL_TOKEN_KINDS].some((kind) => kinds.has(kind))
      );
    });
    if (
      expectsEnforcementDelete &&
      (!hasEnforcementCandidate ||
        value.images.some(
          (image) => classifyCommercialOcrLetterScript(image.transcript).latinLetterCount > 0,
        ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['images'],
        message: `DELETE enforcement expectations require a Cyrillic-only evidence source with at least ${COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS} Cyrillic letters and no Latin image transcript`,
      });
    }
    if (
      expectsCommercialDelete &&
      !value.images.some((image) => {
        const kinds = new Set(image.criticalTokens.map((token) => token.kind));
        return (
          kinds.has('commercial_anchor') &&
          [...DEAL_CRITICAL_TOKEN_KINDS].some((kind) => kinds.has(kind))
        );
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['images'],
        message: 'commercial DELETE expectations require annotated anchor and deal evidence',
      });
    }
    for (let imageIndex = 0; imageIndex < value.images.length; imageIndex += 1) {
      const image = value.images[imageIndex]!;
      const tokenKeys = image.criticalTokens.map(
        (token) => `${token.kind}:${normalizeCommercialOcrEvalCriticalToken(token)}`,
      );
      if (new Set(tokenKeys).size !== tokenKeys.length) {
        context.addIssue({
          code: 'custom',
          path: ['images', imageIndex, 'criticalTokens'],
          message: 'critical tokens must be unique within an image',
        });
      }
      for (let tokenIndex = 0; tokenIndex < image.criticalTokens.length; tokenIndex += 1) {
        const token = image.criticalTokens[tokenIndex]!;
        if (!criticalTokenAppearsInTranscript(token, image.transcript)) {
          context.addIssue({
            code: 'custom',
            path: ['images', imageIndex, 'criticalTokens', tokenIndex, 'value'],
            message: 'critical token value must be present in the annotated transcript',
          });
        }
      }
      if (classifyTranscriptScript(image.transcript) !== image.imageTextScript) {
        context.addIssue({
          code: 'custom',
          path: ['images', imageIndex, 'imageTextScript'],
          message: 'image text script does not match the annotated transcript',
        });
      }
    }
    if (value.statisticsRepresentative && value.split !== 'holdout') {
      context.addIssue({
        code: 'custom',
        path: ['statisticsRepresentative'],
        message: 'statistics representative must belong to holdout split',
      });
    }
    const hasCaption = value.caption.trim().length > 0;
    if (hasCaption === (value.captionLanguage === 'none')) {
      context.addIssue({
        code: 'custom',
        path: ['captionLanguage'],
        message: hasCaption
          ? 'non-empty caption cannot use none language'
          : 'empty caption requires none language',
      });
    }
  });

const settingsProfileSchema = z
  .object({
    id: z.string().regex(OPAQUE_ID_PATTERN),
    commercialAdsSensitivity: z.enum(['BALANCED', 'STRICT']),
    commercialAdsWarnThreshold: z.number().int().min(10).max(90),
    commercialAdsDeleteThreshold: z.number().int().min(20).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.commercialAdsDeleteThreshold <= value.commercialAdsWarnThreshold) {
      context.addIssue({
        code: 'custom',
        path: ['commercialAdsDeleteThreshold'],
        message: 'delete threshold must be greater than warn threshold',
      });
    }
  });

export const commercialOcrEvalManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    corpusId: z.string().regex(OPAQUE_ID_PATTERN),
    corpusRevision: z.string().regex(OPAQUE_ID_PATTERN),
    cases: z.array(commercialOcrEvalCaseV1Schema).min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const clusterLabels = new Map<string, 'DELETE' | 'NO_ACTION'>();
    for (let index = 0; index < value.cases.length; index += 1) {
      const fixture = value.cases[index]!;
      const id = fixture.id;
      if (ids.has(id)) {
        context.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: 'duplicate id' });
      }
      ids.add(id);
      const clusterLabel = clusterLabels.get(fixture.clusterId);
      if (clusterLabel && clusterLabel !== fixture.expectedAction) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'clusterId'],
          message: 'cluster contains conflicting expected actions',
        });
      }
      clusterLabels.set(fixture.clusterId, fixture.expectedAction);
    }
  });

export const commercialOcrEvalManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    corpusId: z.string().regex(OPAQUE_ID_PATTERN),
    corpusRevision: z.string().regex(OPAQUE_ID_PATTERN),
    provenance: z
      .object({
        sourceKind: z.enum(['production_temporal', 'synthetic', 'public_dataset']),
        windowStartedAt: z.string().datetime({ offset: true }).nullable(),
        windowEndedAt: z.string().datetime({ offset: true }).nullable(),
        frozenAt: z.string().datetime({ offset: true }),
        collectionProtocolVersion: z.string().regex(OPAQUE_ID_PATTERN),
        annotationProtocolVersion: z.string().regex(OPAQUE_ID_PATTERN),
        collectionArtifact: provenanceArtifactSchema,
        adjudicationArtifact: provenanceArtifactSchema,
      })
      .strict(),
    settingsProfiles: z.array(settingsProfileSchema).min(1).max(32),
    cases: z.array(commercialOcrEvalCaseV2Schema).min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    const caseIds = new Set<string>();
    const profileIds = new Set<string>();
    const profileConfigurations = new Set<string>();
    const clusterSplits = new Map<string, string>();
    const representativeCounts = new Map<string, number>();
    const imageDigestOwners = new Map<string, { split: string; clusterId: string }>();
    for (let index = 0; index < value.settingsProfiles.length; index += 1) {
      const profile = value.settingsProfiles[index]!;
      const profileId = profile.id;
      if (profileIds.has(profileId)) {
        context.addIssue({
          code: 'custom',
          path: ['settingsProfiles', index, 'id'],
          message: 'duplicate settings profile id',
        });
      }
      profileIds.add(profileId);
      const configuration = JSON.stringify({
        commercialAdsSensitivity: profile.commercialAdsSensitivity,
        commercialAdsWarnThreshold: profile.commercialAdsWarnThreshold,
        commercialAdsDeleteThreshold: profile.commercialAdsDeleteThreshold,
      });
      if (profileConfigurations.has(configuration)) {
        context.addIssue({
          code: 'custom',
          path: ['settingsProfiles', index],
          message: 'settings profiles must not duplicate an existing behavior configuration',
        });
      }
      profileConfigurations.add(configuration);
    }
    for (let index = 0; index < value.cases.length; index += 1) {
      const fixture = value.cases[index]!;
      if (caseIds.has(fixture.id)) {
        context.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: 'duplicate id' });
      }
      caseIds.add(fixture.id);
      const clusterSplit = clusterSplits.get(fixture.clusterId);
      if (clusterSplit && clusterSplit !== fixture.split) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'clusterId'],
          message: 'cluster crosses corpus splits',
        });
      }
      clusterSplits.set(fixture.clusterId, fixture.split);
      for (let imageIndex = 0; imageIndex < fixture.images.length; imageIndex += 1) {
        const imageDigest = fixture.images[imageIndex]!.sha256;
        const digestOwner = imageDigestOwners.get(imageDigest);
        if (digestOwner && digestOwner.split !== fixture.split) {
          context.addIssue({
            code: 'custom',
            path: ['cases', index, 'images', imageIndex, 'sha256'],
            message: 'image digest crosses corpus splits',
          });
        }
        if (digestOwner && digestOwner.clusterId !== fixture.clusterId) {
          context.addIssue({
            code: 'custom',
            path: ['cases', index, 'images', imageIndex, 'sha256'],
            message: 'image digest crosses independent clusters',
          });
        }
        imageDigestOwners.set(imageDigest, {
          split: fixture.split,
          clusterId: fixture.clusterId,
        });
      }
      if (fixture.statisticsRepresentative) {
        representativeCounts.set(
          fixture.clusterId,
          (representativeCounts.get(fixture.clusterId) ?? 0) + 1,
        );
      }
      for (const expectation of fixture.expectations) {
        const profileId = expectation.settingsProfileId;
        if (!profileIds.has(profileId)) {
          context.addIssue({
            code: 'custom',
            path: ['cases', index, 'expectations'],
            message: `unknown settings profile id ${profileId}`,
          });
        }
      }
      if (
        (fixture.statisticsRepresentative || fixture.split === 'adversarial') &&
        (fixture.expectations.length !== profileIds.size ||
          fixture.expectations.some(
            (expectation) => !profileIds.has(expectation.settingsProfileId),
          ))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'expectations'],
          message:
            fixture.split === 'adversarial'
              ? 'adversarial case requires expectations for every settings profile'
              : 'statistics representative requires expectations for every settings profile',
        });
      }
    }
    for (const [clusterId, split] of clusterSplits) {
      const count = representativeCounts.get(clusterId) ?? 0;
      if (split === 'holdout' && count !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['cases'],
          message: `holdout cluster ${clusterId} requires exactly one statistics representative`,
        });
      }
      if (split !== 'holdout' && count !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['cases'],
          message: `non-holdout cluster ${clusterId} cannot have a statistics representative`,
        });
      }
    }
    const frozenAtMs = Date.parse(value.provenance.frozenAt);
    for (let index = 0; index < value.cases.length; index += 1) {
      if (Date.parse(value.cases[index]!.annotation.reviewedAt) > frozenAtMs) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'annotation', 'reviewedAt'],
          message: 'annotation review must not be later than corpus freeze time',
        });
      }
    }
    const { sourceKind, windowStartedAt, windowEndedAt } = value.provenance;
    if (sourceKind === 'production_temporal') {
      if (
        !windowStartedAt ||
        !windowEndedAt ||
        Date.parse(windowStartedAt) >= Date.parse(windowEndedAt) ||
        Date.parse(windowEndedAt) > frozenAtMs
      ) {
        context.addIssue({
          code: 'custom',
          path: ['provenance'],
          message: 'production temporal corpus requires an ordered source window before freeze',
        });
      } else {
        const windowStartedAtMs = Date.parse(windowStartedAt);
        for (let index = 0; index < value.cases.length; index += 1) {
          if (Date.parse(value.cases[index]!.annotation.reviewedAt) < windowStartedAtMs) {
            context.addIssue({
              code: 'custom',
              path: ['cases', index, 'annotation', 'reviewedAt'],
              message: 'annotation review must not predate the production source window',
            });
          }
        }
      }
    } else if (windowStartedAt !== null || windowEndedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'non-temporal corpus must not declare a source window',
      });
    }
    if (
      value.provenance.collectionArtifact.path === value.provenance.adjudicationArtifact.path ||
      value.provenance.collectionArtifact.sha256 === value.provenance.adjudicationArtifact.sha256
    ) {
      context.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'collection and adjudication provenance artifacts must be distinct',
      });
    }
  });

export const commercialOcrEvalManifestSchema = z.discriminatedUnion('schemaVersion', [
  commercialOcrEvalManifestV1Schema,
  commercialOcrEvalManifestV2Schema,
]);

export const commercialOcrEvalCaseSchema = z.union([
  commercialOcrEvalCaseV1Schema,
  commercialOcrEvalCaseV2Schema,
]);

export type CommercialOcrEvalManifest = z.infer<typeof commercialOcrEvalManifestSchema>;
export type CommercialOcrEvalCase = z.infer<typeof commercialOcrEvalCaseSchema>;
export type CommercialOcrEvalCaseV1 = z.infer<typeof commercialOcrEvalCaseV1Schema>;
export type CommercialOcrEvalCaseV2 = z.infer<typeof commercialOcrEvalCaseV2Schema>;

export function isCommercialOcrEvalCyrillicGroundTruthEligible(
  value: CommercialOcrEvalCaseV2,
): boolean {
  return (
    value.images.some((image) => {
      const script = classifyCommercialOcrLetterScript(image.transcript);
      return (
        image.imageTextScript === 'cyrillic_only' &&
        script.cyrillicLetterCount >= COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS
      );
    }) &&
    value.images.every(
      (image) => classifyCommercialOcrLetterScript(image.transcript).latinLetterCount === 0,
    )
  );
}

export function normalizeCommercialOcrEvalCriticalToken(
  token: Readonly<{ kind: CriticalTokenKind; value: string }>,
): string {
  const value = token.value.normalize('NFKC').toLocaleLowerCase('ru-RU').trim();
  if (token.kind === 'phone' || token.kind === 'price') {
    return value.replace(/\D/gu, '');
  }
  if (token.kind === 'domain') {
    return value
      .replace(/^https?:\/\//u, '')
      .replace(/^www\./u, '')
      .replace(/\s+/gu, '');
  }
  if (token.kind === 'handle') {
    return value.replace(/\s+/gu, '');
  }
  return normalizeTranscriptWords(value);
}

export function criticalTokenAppearsInTranscript(
  token: Readonly<{ kind: CriticalTokenKind; value: string }>,
  transcript: string,
): boolean {
  const needle = normalizeCommercialOcrEvalCriticalToken(token);
  if (!needle) return false;
  const normalizedTranscript = transcript.normalize('NFKC').toLocaleLowerCase('ru-RU');
  if (token.kind === 'phone') {
    const canonicalNeedle = canonicalPhoneDigits(needle);
    return numericCandidateDigits(normalizedTranscript).some(
      (candidate) => canonicalPhoneDigits(candidate) === canonicalNeedle,
    );
  }
  if (token.kind === 'price') {
    return numericCandidateDigits(normalizedTranscript).some((candidate) => candidate === needle);
  }
  if (token.kind === 'domain') {
    return normalizedTranscript
      .replace(/https?:\/\//gu, '')
      .replace(/www\./gu, '')
      .replace(/\s+/gu, '')
      .includes(needle);
  }
  if (token.kind === 'handle') {
    return normalizedTranscript.replace(/\s+/gu, '').includes(needle);
  }
  return ` ${normalizeTranscriptWords(normalizedTranscript)} `.includes(` ${needle} `);
}

function normalizeTranscriptWords(value: string): string {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]).join(' ');
}

function numericCandidateDigits(value: string): string[] {
  return Array.from(value.matchAll(/\+?\d(?:[\s().,/'\-\u2013\u2014_]{0,8}\d){0,31}/gu), (match) =>
    match[0].replace(/\D/gu, ''),
  );
}

function canonicalPhoneDigits(value: string): string {
  return value.length === 11 && (value.startsWith('7') || value.startsWith('8'))
    ? value.slice(1)
    : value;
}

function canonicalReviewerDecision(value: {
  commercialSubtype: z.infer<typeof commercialSubtypeSchema> | null;
  expectations: readonly z.infer<typeof settingsExpectationSchema>[];
}): string {
  return JSON.stringify({
    commercialSubtype: value.commercialSubtype,
    expectations: [...value.expectations].sort((left, right) =>
      left.settingsProfileId.localeCompare(right.settingsProfileId),
    ),
  });
}

function classifyTranscriptScript(
  value: string,
): 'cyrillic_only' | 'latin_only' | 'mixed' | 'unknown' {
  return classifyCommercialOcrLetterScript(value).letterScript;
}

export async function loadCommercialOcrEvalManifest(manifestPath: string): Promise<{
  manifest: CommercialOcrEvalManifest;
  manifestPath: string;
  manifestSha256: string;
  corpusRoot: string;
}> {
  const requestedManifestPath = resolve(manifestPath);
  const requestedMetadata = await lstat(requestedManifestPath);
  if (!requestedMetadata.isFile()) {
    throw new Error('Commercial OCR eval manifest must be a regular file, not a symlink');
  }
  const canonicalManifestPath = await realpath(requestedManifestPath);
  const corpusRoot = dirname(canonicalManifestPath);
  await assertCommercialOcrCorpusRootPrivate(corpusRoot);
  const raw = await readBoundedRegularFile({
    pathname: canonicalManifestPath,
    maxBytes: MAX_MANIFEST_BYTES,
    label: 'Commercial OCR eval manifest',
    allowedRoot: corpusRoot,
  });
  const manifest = commercialOcrEvalManifestSchema.parse(JSON.parse(raw.toString('utf8')));
  if (manifest.schemaVersion === 2) {
    await Promise.all([
      verifyCommercialOcrEvalProvenanceArtifact({
        corpusRoot,
        artifact: manifest.provenance.collectionArtifact,
        label: 'Commercial OCR collection provenance artifact',
      }),
      verifyCommercialOcrEvalProvenanceArtifact({
        corpusRoot,
        artifact: manifest.provenance.adjudicationArtifact,
        label: 'Commercial OCR adjudication provenance artifact',
      }),
    ]);
  }
  return {
    manifest,
    manifestPath: canonicalManifestPath,
    manifestSha256: createHash('sha256').update(raw).digest('hex'),
    corpusRoot,
  };
}

async function verifyCommercialOcrEvalProvenanceArtifact(params: {
  corpusRoot: string;
  artifact: { path: string; sha256: string };
  label: string;
}): Promise<void> {
  const pathname = await resolveCorpusPath(params.corpusRoot, params.artifact.path);
  const consumed = await consumeBoundedRegularFile({
    pathname,
    maxBytes: MAX_PROVENANCE_ARTIFACT_BYTES,
    label: params.label,
    allowedRoot: params.corpusRoot,
    collectBytes: false,
  });
  if (consumed.sha256 !== params.artifact.sha256) {
    throw new Error(`${params.label} digest mismatch`);
  }
}

export async function readVerifiedCommercialOcrEvalImage(params: {
  corpusRoot: string;
  image: CommercialOcrEvalCase['images'][number];
  maxBytes: number;
}): Promise<Buffer> {
  const bytes = await consumeVerifiedCommercialOcrEvalImage(params, true);
  if (!bytes) {
    throw new Error('Commercial OCR eval image could not be read');
  }
  return bytes;
}

export async function verifyCommercialOcrEvalImage(params: {
  corpusRoot: string;
  image: CommercialOcrEvalCase['images'][number];
  maxBytes: number;
}): Promise<void> {
  await consumeVerifiedCommercialOcrEvalImage(params, false);
}

async function consumeVerifiedCommercialOcrEvalImage(
  params: {
    corpusRoot: string;
    image: CommercialOcrEvalCase['images'][number];
    maxBytes: number;
  },
  collectBytes: boolean,
): Promise<Buffer | null> {
  if (
    !Number.isSafeInteger(params.maxBytes) ||
    params.maxBytes < 1 ||
    params.maxBytes > MAX_EVAL_IMAGE_BYTES
  ) {
    throw new Error(`Commercial OCR eval maxBytes must be between 1 and ${MAX_EVAL_IMAGE_BYTES}`);
  }
  const canonicalRoot = await realpath(resolve(params.corpusRoot));
  await assertCommercialOcrCorpusRootPrivate(canonicalRoot);
  const imagePath = await resolveCorpusPath(canonicalRoot, params.image.path);
  const consumed = await consumeBoundedRegularFile({
    pathname: imagePath,
    maxBytes: params.maxBytes,
    label: 'Commercial OCR eval image',
    allowedRoot: canonicalRoot,
    collectBytes,
  });
  if (consumed.sha256 !== params.image.sha256) {
    throw new Error('Commercial OCR eval image digest mismatch');
  }
  if (!detectSupportedPhotoImageFormat(consumed.signature)) {
    throw new Error('Commercial OCR eval image has an unsupported image signature');
  }
  return consumed.bytes;
}

async function resolveCorpusPath(corpusRoot: string, requestedPath: string): Promise<string> {
  if (isAbsolute(requestedPath) || requestedPath.includes('\0')) {
    throw new Error('Commercial OCR eval image path must be relative');
  }
  const resolved = resolve(corpusRoot, requestedPath);
  assertPathContained(corpusRoot, resolved);
  const canonicalPath = await realpath(resolved);
  if (!isPathContained(corpusRoot, canonicalPath)) {
    throw new Error('Commercial OCR eval image symlink escapes the corpus root');
  }
  return canonicalPath;
}

function assertPathContained(root: string, pathname: string): void {
  if (!isPathContained(root, pathname)) {
    throw new Error('Commercial OCR eval image path escapes the corpus root');
  }
}

function isPathContained(root: string, pathname: string): boolean {
  const relativePath = relative(root, pathname);
  return !(
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  );
}

async function readBoundedRegularFile(params: {
  pathname: string;
  maxBytes: number;
  label: string;
  allowedRoot: string;
}): Promise<Buffer> {
  const consumed = await consumeBoundedRegularFile({ ...params, collectBytes: true });
  if (!consumed.bytes) {
    throw new Error(`${params.label} could not be read`);
  }
  return consumed.bytes;
}

async function consumeBoundedRegularFile(params: {
  pathname: string;
  maxBytes: number;
  label: string;
  allowedRoot: string;
  collectBytes: boolean;
}): Promise<{ bytes: Buffer | null; sha256: string; signature: Buffer }> {
  const handle = await open(params.pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const openedPath = await resolveOpenedFilePath(handle, params.pathname, metadata);
    if (!isPathContained(params.allowedRoot, openedPath)) {
      throw new Error(`${params.label} resolves outside the corpus root`);
    }
    if (!metadata.isFile()) {
      throw new Error(`${params.label} must be a regular file`);
    }
    if (metadata.size < 1 || metadata.size > params.maxBytes) {
      throw new Error(`${params.label} size must be between 1 and ${params.maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    const signature = Buffer.allocUnsafe(12);
    let signatureBytes = 0;
    const digest = createHash('sha256');
    let totalBytes = 0;
    while (true) {
      const remaining = params.maxBytes - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > params.maxBytes) {
        throw new Error(`${params.label} exceeds ${params.maxBytes} bytes`);
      }
      const data = chunk.subarray(0, bytesRead);
      digest.update(data);
      if (signatureBytes < signature.byteLength) {
        const copied = data.copy(
          signature,
          signatureBytes,
          0,
          Math.min(data.byteLength, signature.byteLength - signatureBytes),
        );
        signatureBytes += copied;
      }
      if (params.collectBytes) {
        chunks.push(data);
      }
    }
    if (totalBytes < 1) {
      throw new Error(`${params.label} must not be empty`);
    }
    return {
      bytes: params.collectBytes ? Buffer.concat(chunks, totalBytes) : null,
      sha256: digest.digest('hex'),
      signature: signature.subarray(0, signatureBytes),
    };
  } finally {
    await handle.close();
  }
}

async function resolveOpenedFilePath(
  handle: FileHandle,
  pathname: string,
  openedMetadata: Stats,
): Promise<string> {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  const [canonicalPath, currentMetadata] = await Promise.all([realpath(pathname), stat(pathname)]);
  if (openedMetadata.dev !== currentMetadata.dev || openedMetadata.ino !== currentMetadata.ino) {
    throw new Error('Commercial OCR eval file changed while it was being opened');
  }
  return canonicalPath;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  return typeof error.code === 'string' ? error.code : null;
}

async function assertCommercialOcrCorpusRootPrivate(corpusRoot: string): Promise<void> {
  let verification = verifiedPrivateRoots.get(corpusRoot);
  if (!verification) {
    verification = verifyCommercialOcrCorpusRootPrivate(corpusRoot).catch((error: unknown) => {
      verifiedPrivateRoots.delete(corpusRoot);
      throw error;
    });
    verifiedPrivateRoots.set(corpusRoot, verification);
  }
  await verification;
}

async function verifyCommercialOcrCorpusRootPrivate(corpusRoot: string): Promise<void> {
  const repository = await runGit(corpusRoot, ['rev-parse', '--show-toplevel']);
  if (
    repository.exitCode === 128 &&
    /^fatal: not a git repository(?: \(or any of the parent directories\))?:/mu.test(
      repository.stderr,
    )
  ) {
    return;
  }
  if (repository.exitCode !== 0 || !repository.stdout.trim()) {
    throw new Error('Unable to verify that the Commercial OCR eval corpus is private');
  }
  const repositoryRoot = await realpath(repository.stdout.trim());
  if (!isPathContained(repositoryRoot, corpusRoot) || repositoryRoot === corpusRoot) {
    throw new Error('Commercial OCR eval corpus must be outside Git or under an ignored directory');
  }
  const repositoryPath = relative(repositoryRoot, corpusRoot);
  const tracked = await runGit(repositoryRoot, [
    '--literal-pathspecs',
    'ls-files',
    '--',
    repositoryPath,
  ]);
  if (tracked.exitCode !== 0) {
    throw new Error('Unable to verify that the Commercial OCR eval corpus is untracked');
  }
  if (tracked.stdout.length > 0) {
    throw new Error('Commercial OCR eval corpus contains Git-tracked files');
  }
  const ignored = await runGit(repositoryRoot, [
    'check-ignore',
    '--quiet',
    '--no-index',
    '--',
    `./${repositoryPath}`,
  ]);
  if (ignored.exitCode === 1) {
    throw new Error('Commercial OCR eval corpus must be outside Git or under an ignored directory');
  }
  if (ignored.exitCode !== 0) {
    throw new Error('Unable to verify that the Commercial OCR eval corpus is ignored');
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolvePromise({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}
