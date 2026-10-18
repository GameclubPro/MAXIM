import {
  readMaxHttpFailureAssociation,
  type MaxHttpFailureAssociation,
  type MaxHttpFailureFacts,
} from './max-http-failure-association';

export type MaxActionFailureFacts =
  | Readonly<{ failureOrigin: 'local_quota'; isCritical: true }>
  | Readonly<{ failureOrigin: 'unlinked'; isCritical: boolean }>;

export type MaxActionFailureDiagnostic = MaxActionFailureFacts &
  (
    | Readonly<{
        requestAssociation: 'unlinked';
        method: 'unknown';
        endpointKind: 'unknown';
      }>
    | (Readonly<{ requestAssociation: 'linked' }> & MaxHttpFailureFacts)
  );

export function projectMaxActionFailureDiagnostic(
  facts: MaxActionFailureFacts,
  association?: MaxHttpFailureAssociation | null,
): MaxActionFailureDiagnostic {
  if (facts.failureOrigin === 'local_quota') {
    return {
      failureOrigin: 'local_quota',
      isCritical: true,
      requestAssociation: 'unlinked',
      method: 'unknown',
      endpointKind: 'unknown',
    };
  }
  const linked = readMaxHttpFailureAssociation(association);
  if (linked) {
    return {
      failureOrigin: 'unlinked',
      isCritical: facts.isCritical,
      requestAssociation: 'linked',
      ...linked,
    };
  }
  return {
    failureOrigin: 'unlinked',
    isCritical: facts.isCritical,
    requestAssociation: 'unlinked',
    method: 'unknown',
    endpointKind: 'unknown',
  };
}
