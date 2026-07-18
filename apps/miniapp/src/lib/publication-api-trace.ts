import {
  getMiniappBridgePlatform,
  isMiniappBootTraceManuallyEnabled,
  traceMiniappBoot,
} from './boot-trace';

const MAX_BOOT_TRACE_ELAPSED_MS = 10 * 60_000;
const reportedPublicationApiSamples = new Set<string>();

export type PublicationApiOperation =
  | 'list'
  | 'details'
  | 'calendar'
  | 'publish'
  | 'update'
  | 'action'
  | 'deliveries';
type PublicationApiOutcome = 'ok' | 'error';

export function shouldEnablePublicationApiTrace(
  userAgent: string,
  platform: string | null,
  manualOverride: boolean,
): boolean {
  const normalizedPlatform = platform?.trim().toLowerCase() ?? '';
  return (
    manualOverride ||
    /\bMAX\//iu.test(userAgent) ||
    normalizedPlatform === 'ios' ||
    normalizedPlatform === 'android'
  );
}

function isPublicationTraceEnabled(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return shouldEnablePublicationApiTrace(
    navigator.userAgent || '',
    getMiniappBridgePlatform(),
    isMiniappBootTraceManuallyEnabled,
  );
}

export function tracePublicationApi(
  operation: PublicationApiOperation,
  outcome: PublicationApiOutcome,
  durationMs: number,
): void {
  if (!isPublicationTraceEnabled()) {
    return;
  }

  const elapsedMs = typeof performance === 'undefined' ? 0 : performance.now();
  if (
    !claimPublicationApiTraceSample(operation, outcome, elapsedMs, reportedPublicationApiSamples)
  ) {
    return;
  }

  traceMiniappBoot(
    'publication_api',
    {
      operation,
      outcome,
      durationMs: Math.max(0, Math.round(durationMs)),
    },
    {
      includeRoute: false,
      maxElapsedMs: MAX_BOOT_TRACE_ELAPSED_MS,
      runtimeEnabled: true,
    },
  );
}

export function claimPublicationApiTraceSample(
  operation: PublicationApiOperation,
  outcome: PublicationApiOutcome,
  elapsedMs: number,
  samples: Set<string>,
): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_BOOT_TRACE_ELAPSED_MS) {
    return false;
  }

  const key = `${operation}:${outcome}`;
  if (samples.has(key)) {
    return false;
  }
  samples.add(key);
  return true;
}
