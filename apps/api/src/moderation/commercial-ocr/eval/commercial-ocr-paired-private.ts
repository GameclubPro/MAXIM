import { ConfigService } from '@nestjs/config';
import { CommercialAdDetector } from '../../commercial/commercial-ad.detector';
import { COMMERCIAL_ENGINE_CONFIG } from '../../commercial/commercial-config';
import { COMMERCIAL_INTENT_QUALITY_DECISION_VERSION } from '../../commercial/commercial-policy-cohorts';
import {
  COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES,
  evaluateCommercialOcrEvalGates,
  evaluateCommercialOcrPairedCandidateQualityGates,
  type CommercialOcrEvalGateResult,
} from './commercial-ocr-eval-gates';
import {
  resolveCommercialOcrEvalExecutionConfig,
  runCommercialOcrPairedEval,
  type CommercialOcrEvalCaseResult,
  type CommercialOcrEvalReport,
  type CommercialOcrEvalRunParameters,
} from './commercial-ocr-eval-runner';
import {
  commercialOcrEvalManifestV2Schema,
  COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  loadCommercialOcrEvalManifest,
  verifyCommercialOcrEvalImage,
  type CommercialOcrEvalManifest,
} from './commercial-ocr-eval.schema';

type PrivateSettings = {
  sensitivity: 'BALANCED' | 'STRICT';
  warnThreshold: number;
  deleteThreshold: number;
};
type Outcome = 'DELETE' | 'NO_ACTION' | 'INCOMPLETE';

// FLAG: This workflow reads only a private frozen corpus. It never contacts MAX,
// admits production jobs, writes an OCR cache, signs evidence or authorizes removal.
export async function evaluateCommercialOcrPairedPrivatePhotos(
  params: CommercialOcrEvalRunParameters,
) {
  const unavailable = (reason: string) => ({
    schemaVersion: 'commercial-ocr-paired-private/v1' as const,
    status: 'UNAVAILABLE' as const,
    evaluated: false as const,
    reason,
    baselineDecisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
    candidateDecisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
    minimumNegativeUnits: COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES.minEligibleNoActionCases,
    minimumPositiveUnits: COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES.minDeleteCases,
    pairedReductionSupportedWithinProvidedCorpus: false,
    independentImprovementProven: false,
    promotionAuthorized: false,
    certificationRequest: null,
    executedDeletions: 0,
  });
  let loaded: Awaited<ReturnType<typeof loadCommercialOcrEvalManifest>>;
  try {
    loaded = await (params.dependencies?.loadManifest ?? loadCommercialOcrEvalManifest)(
      params.manifestPath,
    );
  } catch {
    return unavailable('private_corpus_or_annotation_artifacts_unavailable');
  }
  const parsed = commercialOcrEvalManifestV2Schema.safeParse(loaded.manifest);
  if (!parsed.success) return unavailable('two_independent_original_image_reviews_required');
  const manifest = parsed.data;
  const config = params.config ?? new ConfigService(process.env);
  const execution = resolveCommercialOcrEvalExecutionConfig(config, 1);
  const verifyImage = params.dependencies?.verifyImage ?? verifyCommercialOcrEvalImage;
  try {
    // Verify every original before native execution; captions/transcripts are never substitutes.
    for (const fixture of manifest.cases) {
      for (const image of fixture.images) {
        await verifyImage({
          corpusRoot: loaded.corpusRoot,
          image,
          maxBytes: execution.maxSourceImageBytes,
        });
      }
    }
  } catch {
    return unavailable('private_original_images_unavailable_or_changed');
  }
  let reports: Awaited<ReturnType<typeof runCommercialOcrPairedEval>>;
  try {
    reports = await runCommercialOcrPairedEval({
      ...params,
      config,
      concurrency: 1,
      dependencies: {
        ...params.dependencies,
        loadManifest: async () => ({ ...loaded, manifest }),
        verifyImage,
      },
      createCandidateDetector: () => {
        const detector = new CommercialAdDetector();
        return { detect: (input) => detector.detectExperimental(input) };
      },
    });
  } catch {
    return unavailable('native_execution_or_provenance_unavailable');
  }
  const baselineGates = evaluateCommercialOcrEvalGates(reports.baseline);
  const candidateGates = evaluateCommercialOcrPairedCandidateQualityGates(reports.candidate);
  const comparisons = manifest.settingsProfiles.map((profile) => {
    const baseline = representatives(reports.baseline, profile.id);
    const candidateById = new Map(
      representatives(reports.candidate, profile.id).map((row) => [row.id, row]),
    );
    const negatives = baseline.filter(
      (row) => row.expectedCommercialAction === 'NO_ACTION' && row.cyrillicGroundTruthEligible,
    );
    const positives = baseline.filter((row) => row.expectedEnforcementAction === 'DELETE');
    const pair = (rows: CommercialOcrEvalCaseResult[], isError: (outcome: Outcome) => boolean) =>
      pairedErrors(
        rows.map((row) => [
          isError(row.actualEnforcementAction),
          isError(candidateById.get(row.id)?.actualEnforcementAction ?? 'INCOMPLETE'),
        ]),
      );
    const falseDeletionPermissions = pair(negatives, (outcome) => outcome === 'DELETE');
    const chainMisses = pair(positives, (outcome) => outcome !== 'DELETE');
    return {
      settings: settingsFor(profile),
      independentNegativeUnits: negatives.length,
      independentPositiveUnits: positives.length,
      falseDeletionPermissions,
      chainMisses,
      baselineIncompleteNegativeUnits: negatives.filter(
        (row) => row.actualEnforcementAction === 'INCOMPLETE',
      ).length,
      baselineIncompletePositiveUnits: positives.filter(
        (row) => row.actualEnforcementAction === 'INCOMPLETE',
      ).length,
      candidateIncompleteNegativeUnits: negatives.filter(
        (row) => candidateById.get(row.id)?.actualEnforcementAction === 'INCOMPLETE',
      ).length,
      candidateIncompletePositiveUnits: positives.filter(
        (row) => candidateById.get(row.id)?.actualEnforcementAction === 'INCOMPLETE',
      ).length,
      bothErrorRatesReduced:
        falseDeletionPermissions.significantReduction && chainMisses.significantReduction,
    };
  });
  const incomplete = reports.baseline.incomplete > 0 || reports.candidate.incomplete > 0;
  const pairedReductionSupported =
    !incomplete &&
    candidateGates.passed &&
    comparisons.length > 0 &&
    comparisons.every((row) => row.bothErrorRatesReduced);
  // FLAG: The v2 image manifest declares image clusters, not a complete random author/campaign
  // frame or a separately frozen 7-day development window plus 24h gap. These extra attestations
  // are required before the plan's independent temporal improvement can be claimed.
  return {
    schemaVersion: 'commercial-ocr-paired-private/v1' as const,
    status: incomplete ? ('INCOMPLETE' as const) : ('EVALUATED' as const),
    evaluated: true as const,
    scope: 'provided_frozen_private_original_images_with_two_native_passes',
    sourceCases: manifest.cases.length,
    images: manifest.cases.reduce((sum, row) => sum + row.images.length, 0),
    annotationProtocolVersion:
      manifest.provenance.annotationProtocolVersion ===
      COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION
        ? COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION
        : 'UNSUPPORTED',
    manifestSha256: reports.baseline.provenance.artifact?.manifestSha256 ?? null,
    sharedNativeBehaviorIdentitySha256:
      reports.baseline.provenance.behaviorIdentity?.nativeFingerprintSha256 ?? null,
    baseline: {
      decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
      strictGates: summarizeGates(baselineGates, manifest),
    },
    candidate: {
      policyIdentity: reports.candidate.readonlyCandidatePolicy!,
      strictGates: summarizeGates(candidateGates, manifest),
    },
    performance: {
      measurement: 'one_native_pass_pair_plus_both_policies_per_source',
      conservativeStandaloneSourceDuration: true,
      expectedPasses: reports.baseline.performance.certification.expectedOcrPasses,
      attemptedPasses: reports.baseline.performance.certification.attemptedOcrPasses,
      passCoverage: reports.baseline.performance.certification.passCoverage,
      ocrPassDurationMs: reports.baseline.performance.certification.ocrPassDurationMs,
      sourceCaseDurationMs: reports.baseline.performance.certification.sourceCaseDurationMs,
      throughputImagesPerMinute:
        reports.baseline.performance.certification.throughputImagesPerMinute,
      deadlineUtilization: reports.baseline.performance.certification.deadlineUtilization,
    },
    comparisons,
    pairedReductionSupportedWithinProvidedCorpus: pairedReductionSupported,
    independentImprovementProven: false,
    missingAttestation: 'complete_random_author_campaign_frame_development_window_and_24h_gap',
    executedDeletions: 0,
    promotionAuthorized: false,
    certificationRequest: null,
  };
}

function settingsFor(
  profile: Extract<CommercialOcrEvalManifest, { schemaVersion: 2 }>['settingsProfiles'][number],
): PrivateSettings {
  return {
    sensitivity: profile.commercialAdsSensitivity,
    warnThreshold: profile.commercialAdsWarnThreshold,
    deleteThreshold: profile.commercialAdsDeleteThreshold,
  };
}

function summarizeGates(
  gates: CommercialOcrEvalGateResult,
  manifest: Extract<CommercialOcrEvalManifest, { schemaVersion: 2 }>,
) {
  return {
    passed: gates.passed,
    failureCount: gates.failures.length,
    profileSha256: gates.profileSha256,
    falseDeleteConfidenceLevel:
      COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES.falseDeleteConfidenceLevel,
    recallConfidenceLevel: COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES.deleteRecallConfidenceLevel,
    profiles: manifest.settingsProfiles.map((profile) => ({
      settings: settingsFor(profile),
      // Gate metrics contain only fixed numerical aggregates, never source IDs or raw evidence.
      metrics: gates.metrics.profiles[profile.id] ?? null,
    })),
  };
}

function representatives(report: CommercialOcrEvalReport, profileId: string) {
  return report.cases.filter(
    (row) =>
      row.split === 'holdout' &&
      row.statisticsRepresentative &&
      row.settingsProfileId === profileId,
  );
}

export function pairedErrors(values: readonly (readonly [boolean, boolean])[]) {
  const corrected = values.filter(([baseline, candidate]) => baseline && !candidate).length;
  const regressed = values.filter(([baseline, candidate]) => !baseline && candidate).length;
  const discordant = corrected + regressed;
  let p = 1;
  if (discordant && corrected > regressed) {
    let logTerm = -discordant * Math.LN2;
    const logs = [logTerm];
    for (let index = 1; index <= regressed; index += 1) {
      logTerm += Math.log(discordant - index + 1) - Math.log(index);
      logs.push(logTerm);
    }
    const max = Math.max(...logs);
    p = Math.min(1, Math.exp(max) * logs.reduce((sum, term) => sum + Math.exp(term - max), 0));
  }
  return {
    units: values.length,
    baselineErrors: values.filter(([baseline]) => baseline).length,
    candidateErrors: values.filter(([, candidate]) => candidate).length,
    correctedUnits: corrected,
    regressedUnits: regressed,
    oneSidedExactP: p,
    significantReduction: corrected > regressed && p <= 0.025,
  };
}
