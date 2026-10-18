export type MaxActionFailureFacts =
  | Readonly<{ failureOrigin: 'local_quota'; isCritical: true }>
  | Readonly<{ failureOrigin: 'unlinked'; isCritical: boolean }>;

export type MaxActionFailureDiagnostic = MaxActionFailureFacts &
  Readonly<{
    requestAssociation: 'unlinked';
    method: 'unknown';
    endpointKind: 'unknown';
  }>;

export function projectMaxActionFailureDiagnostic(
  facts: MaxActionFailureFacts,
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
  return {
    failureOrigin: 'unlinked',
    isCritical: facts.isCritical,
    requestAssociation: 'unlinked',
    method: 'unknown',
    endpointKind: 'unknown',
  };
}
