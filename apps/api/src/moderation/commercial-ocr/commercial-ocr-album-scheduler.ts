import type { ChatSettings } from '../../prisma/prisma-client';
import { performance } from 'node:perf_hooks';
import {
  evaluateCommercialOcrDecision,
  type CommercialOcrDecision,
  type CommercialOcrDetector,
  type CommercialOcrImageDecisionInput,
  type CommercialOcrPass,
} from './commercial-ocr-decision-policy';
import type { CommercialOcrPassName } from './commercial-ocr-preprocessor';

export type CommercialOcrAlbumScheduleStageResult<T, TStop> =
  | { kind: 'ready'; value: T }
  | { kind: 'stop'; result: TStop };

export type CommercialOcrAlbumScheduleResult<TStop> =
  | { kind: 'complete'; decision: CommercialOcrDecision }
  | { kind: 'stopped'; result: TStop };

type ScheduledImage = {
  imageIndex: number;
  source: 'direct' | 'forward';
  primary: CommercialOcrPass;
  verification: CommercialOcrPass | null;
};

/**
 * Owns the decision-sensitive album traversal shared by runtime and certification eval.
 * I/O, deadlines, admission and native OCR remain injected by each caller.
 */
export async function runCommercialOcrAlbumSchedule<TContext, TStop>(params: {
  caption: string;
  settings: ChatSettings;
  imageSources: readonly ('direct' | 'forward')[];
  detector?: CommercialOcrDetector;
  requireCompletePrimaryScan?: boolean;
  shouldResolveConfirmation?: (params: {
    imageIndex: number;
    source: 'direct' | 'forward';
    primary: CommercialOcrPass;
  }) => boolean;
  shouldStopAfterConfirmation?: (params: {
    imageIndex: number;
    source: 'direct' | 'forward';
    primary: CommercialOcrPass;
    confirmation: CommercialOcrPass;
  }) => boolean;
  preflight?: () =>
    | CommercialOcrAlbumScheduleStageResult<void, TStop>
    | Promise<CommercialOcrAlbumScheduleStageResult<void, TStop>>;
  createImageContext: (imageIndex: number) => TContext;
  resolvePass: (params: {
    context: TContext;
    imageIndex: number;
    pass: CommercialOcrPassName;
  }) => Promise<CommercialOcrAlbumScheduleStageResult<CommercialOcrPass, TStop>>;
  finishImage?: (context: TContext, imageIndex: number) => void | Promise<void>;
  observePolicyDuration?: (durationMs: number) => void;
}): Promise<CommercialOcrAlbumScheduleResult<TStop>> {
  const expectedImageCount = params.imageSources.length;
  const evaluate = (images: readonly ScheduledImage[]) => {
    const startedAt = performance.now();
    try {
      return evaluateCommercialOcrDecision({
        caption: params.caption,
        expectedImageCount,
        images: toDecisionImages(images),
        settings: params.settings,
        ...(params.detector ? { detector: params.detector } : {}),
      });
    } finally {
      try {
        params.observePolicyDuration?.(Math.max(0, performance.now() - startedAt));
      } catch {
        // Observability must not alter a moderation decision.
      }
    }
  };

  let lastDecision: CommercialOcrDecision | null = null;
  if (params.caption.trim()) {
    const captionDecision = evaluate([]);
    lastDecision = captionDecision;
    if (
      captionDecision.caption.safeContextBucket !== 'none' &&
      !params.requireCompletePrimaryScan
    ) {
      return { kind: 'complete', decision: captionDecision };
    }
  }

  const preflight = await params.preflight?.();
  if (preflight?.kind === 'stop') {
    return { kind: 'stopped', result: preflight.result };
  }

  const images: ScheduledImage[] = [];
  for (let imageIndex = 0; imageIndex < expectedImageCount; imageIndex += 1) {
    const context = params.createImageContext(imageIndex);
    try {
      const primary = await params.resolvePass({ context, imageIndex, pass: 'primary' });
      if (primary.kind === 'stop') {
        return { kind: 'stopped', result: primary.result };
      }
      images.push({
        imageIndex,
        source: params.imageSources[imageIndex]!,
        primary: primary.value,
        verification: null,
      });

      const primaryDecision = evaluate(images);
      lastDecision = primaryDecision;
      if (hasSafeContextVeto(primaryDecision) && !params.requireCompletePrimaryScan) {
        return { kind: 'complete', decision: primaryDecision };
      }
      const shouldResolveConfirmation =
        isCurrentPrimaryDeleteCandidate(primaryDecision, imageIndex) ||
        params.shouldResolveConfirmation?.({
          imageIndex,
          source: params.imageSources[imageIndex]!,
          primary: primary.value,
        }) === true;
      if (!shouldResolveConfirmation) {
        continue;
      }

      const confirmation = await params.resolvePass({
        context,
        imageIndex,
        pass: 'confirmation',
      });
      if (confirmation.kind === 'stop') {
        return { kind: 'stopped', result: confirmation.result };
      }
      images[images.length - 1]!.verification = confirmation.value;

      const confirmedDecision = evaluate(images);
      lastDecision = confirmedDecision;
      if (
        params.shouldStopAfterConfirmation?.({
          imageIndex,
          source: params.imageSources[imageIndex]!,
          primary: primary.value,
          confirmation: confirmation.value,
        }) === true
      ) {
        return { kind: 'complete', decision: confirmedDecision };
      }
      if (hasSafeContextVeto(confirmedDecision) && !params.requireCompletePrimaryScan) {
        return { kind: 'complete', decision: confirmedDecision };
      }
    } finally {
      await params.finishImage?.(context, imageIndex);
    }
  }

  return { kind: 'complete', decision: lastDecision ?? evaluate(images) };
}

function toDecisionImages(images: readonly ScheduledImage[]): CommercialOcrImageDecisionInput[] {
  return images.map((image) => ({
    imageIndex: image.imageIndex,
    source: image.source,
    primary: image.primary,
    verification: image.verification,
  }));
}

function isCurrentPrimaryDeleteCandidate(
  decision: CommercialOcrDecision,
  imageIndex: number,
): boolean {
  return decision.images.some(
    (image) =>
      image.imageIndex === imageIndex &&
      image.primary.deleteEligible &&
      image.primary.criticalSignature.length >= 2 &&
      image.primary.detection !== null,
  );
}

function hasSafeContextVeto(decision: CommercialOcrDecision): boolean {
  return (
    decision.caption.safeContextBucket !== 'none' ||
    decision.reasonCodes.some((reason) => reason.startsWith('image-safe-context:'))
  );
}
