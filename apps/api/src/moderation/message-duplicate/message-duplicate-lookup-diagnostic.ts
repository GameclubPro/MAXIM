export type DuplicateLookupPhase =
  | 'qualification'
  | 'initial_delete'
  | 'delete_recheck'
  | 'sanction'
  | 'notice'
  | 'unclassified_recheck';
type Diagnostic = Readonly<{
  duplicateLookupPhase: DuplicateLookupPhase;
  duplicateLookupSource: 'current' | 'original';
}>;
const failures = new WeakMap<object, Diagnostic>();

// FLAG: Diagnostic provenance never changes the thrown error, its outcome markers,
// retry classification or authority. No source identity or message data is retained.
export function recordDuplicateLookupFailure(
  error: unknown,
  phase: DuplicateLookupPhase,
  source: 'current' | 'original',
): void {
  if (error && (typeof error === 'object' || typeof error === 'function') && !failures.has(error))
    failures.set(
      error,
      Object.freeze({ duplicateLookupPhase: phase, duplicateLookupSource: source }),
    );
}

export function readDuplicateLookupFailure(error: unknown): Diagnostic | undefined {
  return error && (typeof error === 'object' || typeof error === 'function')
    ? failures.get(error)
    : undefined;
}
