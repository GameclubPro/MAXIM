import { AsyncLocalStorage } from 'node:async_hooks';

type Dimensions = {
  mode: 'NOW' | 'ONCE' | 'SLOTS' | 'RECURRENCE' | 'UNKNOWN';
  media: 'none' | 'image' | 'video' | 'unknown';
  lane: 'critical' | 'interactive' | 'background';
};
type Stage =
  | 'pre_http'
  | 'final_admission'
  | 'http'
  | 'send_acknowledgement'
  | 'ledger_persistence'
  | 'acknowledgement_to_ledger'
  | 'acknowledgement_to_recipient'
  | 'ledger_observed_to_recipient';
type Outcome =
  | 'dispatched'
  | 'admitted'
  | 'not_dispatched'
  | 'response_received'
  | 'response_rejected'
  | 'transport_error'
  | 'remote_id_observed'
  | 'remote_id_missing'
  | 'cas_committed'
  | 'exact_readback'
  | 'source_unavailable';
type Observation = Dimensions & {
  metric: 'publication_send_v1';
  source: 'managed_broadcast';
  stage: Stage;
  outcome: Outcome;
  durationMs: number | null;
  clock: 'monotonic' | 'unknown';
};
type Receipt = Readonly<{ acknowledgedAt: number | null; ledgerObservedAt: number | null }>;
type HttpAttempt = {
  admissionAt: number | null;
  startedAt: number | null;
  respondedAt: number | null;
  responseAccepted: boolean;
  started: boolean;
};
type Attempt = {
  key: string;
  active: boolean;
  startedAt: number | null;
  receipt: Receipt;
  lastHttp: HttpAttempt | null;
  emit(stage: Stage, outcome: Outcome, from: number | null, to?: number | null): void;
};
const attempts = new AsyncLocalStorage<Attempt>();
const transports = new AsyncLocalStorage<{ attempt: Attempt; http: HttpAttempt }>();

function safely(callback: () => void): void {
  try {
    callback();
  } catch {
    // FLAG: Observations never own dispatch authority or change its result.
  }
}
function now(): number | null {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
function elapsed(from: number | null, to: number | null): number | null {
  return from !== null && to !== null && to >= from ? Math.round(to - from) : null;
}

export function createMaxSendObservation(
  dimensions: Dimensions,
  sink: (observation: Observation) => void,
): {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
  observeRecipientReceipt(): void;
} {
  let receipt: Receipt | null = null;
  const emit: Attempt['emit'] = (stage, outcome, from, to = now()) =>
    safely(() => {
      const durationMs = elapsed(from, to);
      sink({
        metric: 'publication_send_v1',
        source: 'managed_broadcast',
        mode: dimensions.mode,
        media: dimensions.media,
        lane: dimensions.lane,
        stage,
        outcome,
        durationMs,
        clock: durationMs === null ? 'unknown' : 'monotonic',
      });
    });
  return {
    async run(key, operation) {
      const attempt: Attempt = {
        key,
        active: true,
        startedAt: now(),
        receipt: { acknowledgedAt: null, ledgerObservedAt: null },
        lastHttp: null,
        emit,
      };
      receipt = null;
      try {
        return await attempts.run(attempt, operation);
      } finally {
        // FLAG: Detached work cannot add observations to a settled invocation. Only
        // its immutable local receipt clock survives for the recipient's winning CAS.
        attempt.active = false;
        receipt = Object.freeze({ ...attempt.receipt });
      }
    },
    observeRecipientReceipt: () =>
      safely(() => {
        const persistedAt = now();
        emit(
          'acknowledgement_to_recipient',
          receipt?.acknowledgedAt == null ? 'source_unavailable' : 'cas_committed',
          receipt?.acknowledgedAt ?? null,
          persistedAt,
        );
        emit(
          'ledger_observed_to_recipient',
          receipt?.ledgerObservedAt == null ? 'source_unavailable' : 'cas_committed',
          receipt?.ledgerObservedAt ?? null,
          persistedAt,
        );
        receipt = null;
      }),
  };
}

export function runWithMaxSendHttpObservation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const attempt = attempts.getStore();
  if (!attempt?.active || attempt.key !== key) return transports.exit(operation);
  const http: HttpAttempt = {
    admissionAt: null,
    startedAt: null,
    respondedAt: null,
    responseAccepted: false,
    started: false,
  };
  attempt.lastHttp = http;
  attempt.receipt = { acknowledgedAt: null, ledgerObservedAt: null };
  return transports.run({ attempt, http }, operation).finally(() => {
    if (attempt.active && !http.started)
      attempt.emit('final_admission', 'not_dispatched', http.admissionAt);
  });
}

export function observeMaxSendAdmission(method: string, path: string): void {
  safely(() => {
    const scope = transports.getStore();
    if (scope?.attempt.active && method === 'post' && path === '/messages')
      scope.http.admissionAt = now();
  });
}

export function beginMaxSendHttpObservation(
  method: string,
  path: string,
): {
  received(): (accepted: boolean) => void;
  failed(): void;
} {
  const scope = transports.getStore();
  const enabled = scope?.attempt.active && method === 'post' && path === '/messages';
  if (enabled) {
    scope.http.startedAt = now();
    scope.http.started = true;
  }
  const emitAdmission = () => {
    if (!enabled || !scope.attempt.active) return;
    scope.attempt.emit('pre_http', 'dispatched', scope.attempt.startedAt, scope.http.startedAt);
    scope.attempt.emit('final_admission', 'admitted', scope.http.admissionAt, scope.http.startedAt);
  };
  return {
    received: () => {
      const respondedAt = now();
      return (accepted) =>
        safely(() => {
          if (!enabled || !scope.attempt.active) return;
          scope.http.respondedAt = respondedAt;
          scope.http.responseAccepted = accepted;
          emitAdmission();
          scope.attempt.emit(
            'http',
            accepted ? 'response_received' : 'response_rejected',
            scope.http.startedAt,
            respondedAt,
          );
        });
    },
    failed: () =>
      safely(() => {
        const failedAt = now();
        if (!enabled || !scope.attempt.active) return;
        emitAdmission();
        scope.attempt.emit('http', 'transport_error', scope.http.startedAt, failedAt);
      }),
  };
}

export function observeMaxSendAcknowledgement(key: string, confirmed: boolean): void {
  safely(() => {
    const attempt = attempts.getStore();
    if (!attempt?.active || attempt.key !== key || !attempt.lastHttp?.responseAccepted) return;
    if (confirmed)
      attempt.receipt = { ...attempt.receipt, acknowledgedAt: attempt.lastHttp.respondedAt };
    attempt.emit(
      'send_acknowledgement',
      confirmed ? 'remote_id_observed' : 'remote_id_missing',
      attempt.lastHttp.respondedAt,
    );
  });
}

export function beginMaxSendLedgerObservation(
  key: string,
): (outcome: 'cas_committed' | 'exact_readback') => void {
  const attempt = attempts.getStore();
  const startedAt = now();
  return (outcome) =>
    safely(() => {
      if (!attempt?.active || attempt.key !== key) return;
      const persistedAt = now();
      attempt.receipt = { ...attempt.receipt, ledgerObservedAt: persistedAt };
      attempt.emit('ledger_persistence', outcome, startedAt, persistedAt);
      attempt.emit(
        'acknowledgement_to_ledger',
        outcome,
        attempt.receipt.acknowledgedAt,
        persistedAt,
      );
    });
}
