const ownerBrand = Symbol('max-http-failure-owner');
const requestBrand = Symbol('max-http-failure-request');
const outcomeBrand = Symbol('max-http-outcome');
const associationBrand = Symbol('max-http-failure-association');

export type MaxHttpFailureFacts = Readonly<{
  method: 'get' | 'delete';
  endpointKind: 'messages' | 'chat_members';
  phase: 'adapter_rejection' | 'response_rejection' | 'domain_validation';
  receivedStatusCode: number | null;
}>;

type OwnerState = { active: boolean; consumed: boolean; starts: number };
export type MaxHttpFailureOwner = Readonly<{ [ownerBrand]: OwnerState }>;
type RequestState = Readonly<{
  owner: OwnerState;
  method: MaxHttpFailureFacts['method'];
  endpointKind: MaxHttpFailureFacts['endpointKind'];
  eligible: boolean;
}>;
export type MaxHttpFailureRequest = Readonly<{ [requestBrand]: RequestState | null }>;
type ResponseProof = Readonly<{
  request: RequestState;
  receivedStatusCode: number | null;
  phase: MaxHttpFailureFacts['phase'] | null;
}>;
type OutcomeProof = Readonly<{ [outcomeBrand]: ResponseProof | null }>;
export type MaxHttpOutcome<T> = OutcomeProof &
  (Readonly<{ kind: 'value'; value: T }> | Readonly<{ kind: 'failure'; error: unknown }>);
export type MaxHttpFailureAssociation = MaxHttpFailureFacts &
  Readonly<{ [associationBrand]: true }>;
export type ConsumedMaxHttpOutcome<T> =
  | Readonly<{ kind: 'value'; value: T }>
  | Readonly<{
      kind: 'failure';
      error: unknown;
      association: MaxHttpFailureAssociation | null;
    }>;

export function createMaxHttpFailureOwner(): MaxHttpFailureOwner {
  return { [ownerBrand]: { active: true, consumed: false, starts: 0 } };
}

export function closeMaxHttpFailureOwner(owner: MaxHttpFailureOwner): void {
  try {
    owner[ownerBrand].active = false;
  } catch {
    // FLAG: Diagnostic lifetime cleanup must not replace a business result or error.
  }
}

export function beginMaxHttpFailureRequest(
  owner: MaxHttpFailureOwner,
  method: MaxHttpFailureFacts['method'],
  endpointKind: MaxHttpFailureFacts['endpointKind'],
  eligible = true,
): MaxHttpFailureRequest {
  try {
    const state = owner[ownerBrand];
    if (!state.active || state.consumed) return { [requestBrand]: null };
    // FLAG: Count starts, including ineligible overrides, rather than settlements.
    // Two selected requests must never lend either response a primary association.
    state.starts++;
    return {
      [requestBrand]: {
        owner: state,
        method,
        endpointKind,
        eligible:
          eligible &&
          ((method === 'get' && endpointKind === 'chat_members') ||
            (method === 'delete' &&
              (endpointKind === 'messages' || endpointKind === 'chat_members'))),
      },
    };
  } catch {
    return { [requestBrand]: null };
  }
}

function responseProof(
  association: MaxHttpFailureRequest | null,
  receivedStatusCode: unknown,
  phase: ResponseProof['phase'],
): ResponseProof | null {
  try {
    const request = association?.[requestBrand];
    if (!request) return null;
    return {
      request,
      receivedStatusCode:
        typeof receivedStatusCode === 'number' && Number.isFinite(receivedStatusCode)
          ? receivedStatusCode
          : null,
      phase,
    };
  } catch {
    return null;
  }
}

export function maxHttpValueOutcome<T>(
  association: MaxHttpFailureRequest | null,
  value: T,
  receivedStatusCode: unknown,
): MaxHttpOutcome<T> {
  return {
    kind: 'value',
    value,
    [outcomeBrand]: responseProof(association, receivedStatusCode, null),
  };
}

export function maxHttpFailureOutcome(
  association: MaxHttpFailureRequest | null,
  error: unknown,
  phase: 'adapter_rejection' | 'response_rejection',
  receivedStatusCode: unknown,
): MaxHttpOutcome<never> {
  return {
    kind: 'failure',
    error,
    [outcomeBrand]: responseProof(association, receivedStatusCode, phase),
  };
}

function readOutcomeProof(outcome: OutcomeProof): ResponseProof | null {
  try {
    const proof = outcome[outcomeBrand];
    if (!proof) return null;
    const { owner, method, endpointKind, eligible } = proof.request;
    const { receivedStatusCode, phase } = proof;
    if (
      !owner ||
      !(
        (method === 'get' && endpointKind === 'chat_members') ||
        (method === 'delete' && (endpointKind === 'messages' || endpointKind === 'chat_members'))
      ) ||
      !(
        receivedStatusCode === null ||
        (typeof receivedStatusCode === 'number' && Number.isFinite(receivedStatusCode))
      ) ||
      !(
        phase === null ||
        phase === 'adapter_rejection' ||
        phase === 'response_rejection' ||
        phase === 'domain_validation'
      )
    )
      return null;
    return { request: { owner, method, endpointKind, eligible }, receivedStatusCode, phase };
  } catch {
    return null;
  }
}

export function mapMaxHttpOutcome<T, R>(
  outcome: MaxHttpOutcome<T>,
  mapper: (value: T) => R,
): MaxHttpOutcome<R> {
  if (outcome.kind === 'failure') return outcome;
  const proof = readOutcomeProof(outcome);
  // FLAG: Catch exactly one synchronous domain validator. Diagnostic failure cannot
  // retry it, turn a false value into failure, or change the thrown unknown value.
  try {
    const value = mapper(outcome.value);
    return { kind: 'value', value, [outcomeBrand]: proof };
  } catch (error: unknown) {
    return {
      kind: 'failure',
      error,
      [outcomeBrand]: proof ? { ...proof, phase: 'domain_validation' } : null,
    };
  }
}

export function consumeMaxHttpOutcome<T>(
  owner: MaxHttpFailureOwner,
  outcome: MaxHttpOutcome<T>,
): ConsumedMaxHttpOutcome<T> {
  let association: MaxHttpFailureAssociation | null = null;
  try {
    const state = owner[ownerBrand];
    const proof = readOutcomeProof(outcome);
    if (
      state.active &&
      !state.consumed &&
      state.starts === 1 &&
      proof?.request.owner === state &&
      proof.request.eligible &&
      proof.phase !== null &&
      outcome.kind === 'failure'
    ) {
      association = {
        method: proof.request.method,
        endpointKind: proof.request.endpointKind,
        phase: proof.phase,
        receivedStatusCode: proof.receivedStatusCode,
        [associationBrand]: true,
      };
    }
    state.consumed = true;
  } catch {
    association = null;
  }
  return outcome.kind === 'value'
    ? { kind: 'value', value: outcome.value }
    : { kind: 'failure', error: outcome.error, association };
}

export function readMaxHttpFailureAssociation(
  association: MaxHttpFailureAssociation | null | undefined,
): MaxHttpFailureFacts | null {
  try {
    if (association?.[associationBrand] !== true) return null;
    const { method, endpointKind, phase, receivedStatusCode } = association;
    if (
      !(
        (method === 'get' && endpointKind === 'chat_members') ||
        (method === 'delete' && (endpointKind === 'messages' || endpointKind === 'chat_members'))
      ) ||
      !['adapter_rejection', 'response_rejection', 'domain_validation'].includes(phase) ||
      !(
        receivedStatusCode === null ||
        (typeof receivedStatusCode === 'number' && Number.isFinite(receivedStatusCode))
      )
    )
      return null;
    return { method, endpointKind, phase, receivedStatusCode };
  } catch {
    return null;
  }
}
