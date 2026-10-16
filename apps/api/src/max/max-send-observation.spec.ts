import { performMaxHttpRequest } from './max-http-request';
import { wasMaxMessageSendAttempted } from './max-mutation-outcome.util';
import {
  beginMaxSendLedgerObservation,
  createMaxSendObservation,
  observeMaxSendAcknowledgement,
  observeMaxSendAdmission,
  runWithMaxSendHttpObservation,
} from './max-send-observation';

type Observation = Parameters<Parameters<typeof createMaxSendObservation>[1]>[0];

describe('Exact Publisher SEND observations', () => {
  let clock: number;
  let observations: Observation[];
  const key = 'private-publication-action';
  const dimensions = { mode: 'NOW', media: 'video', lane: 'interactive' } as const;
  const observer = (
    sink: (value: Observation) => void = (value) => {
      observations.push(value);
    },
  ) => createMaxSendObservation(dimensions, sink);

  beforeEach(() => {
    clock = 0;
    observations = [];
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  async function send(actionKey = key, admissionMs = 0) {
    return runWithMaxSendHttpObservation(actionKey, async () => {
      observeMaxSendAdmission('post', '/messages');
      clock += admissionMs;
      return performMaxHttpRequest({
        method: 'post',
        path: '/messages',
        sendAttempted: true,
        request: async () => {
          clock += 1_000;
          return { status: 200, data: { message_id: 'private-remote' } };
        },
        assertResponse: () => undefined,
      });
    });
  }
  const stage = (name: string) => observations.filter((event) => event.stage === name);

  it('separates preparation, final admission, HTTP, ledger commit and recipient commit', async () => {
    const scope = observer();
    await scope.run(key, async () => {
      clock += 500;
      expect(await send(key, 3_000)).toEqual({ message_id: 'private-remote' });
      observeMaxSendAcknowledgement(key, true);
      const persisted = beginMaxSendLedgerObservation(key);
      clock += 2_000;
      persisted('cas_committed');
    });
    clock += 250;
    scope.observeRecipientReceipt();
    expect(stage('pre_http')[0]).toMatchObject({ durationMs: 3_500 });
    expect(stage('final_admission')[0]).toMatchObject({ durationMs: 3_000 });
    expect(stage('http')[0]).toMatchObject({ durationMs: 1_000, outcome: 'response_received' });
    expect(stage('ledger_persistence')[0]).toMatchObject({
      durationMs: 2_000,
      outcome: 'cas_committed',
    });
    expect(stage('acknowledgement_to_recipient')[0]).toMatchObject({ durationMs: 2_250 });
    expect(stage('ledger_observed_to_recipient')[0]).toMatchObject({ durationMs: 250 });
    expect(JSON.stringify(observations)).not.toContain('private');
  });

  it('excludes logging and response validation work from actual HTTP duration', async () => {
    const scope = observer((value) => {
      observations.push(value);
      clock += 100;
    });
    await scope.run(key, () =>
      runWithMaxSendHttpObservation(key, () =>
        performMaxHttpRequest({
          method: 'post',
          path: '/messages',
          sendAttempted: true,
          request: async () => {
            clock += 1_000;
            return { status: 200, data: {} };
          },
          assertResponse: () => {
            clock += 500;
          },
        }),
      ),
    );
    expect(stage('http')[0]).toMatchObject({ durationMs: 1_000 });
  });

  it('records final guard rejection without a transport sample or changing the error', async () => {
    const failure = new Error('private authority refused');
    await expect(
      observer().run(key, () =>
        runWithMaxSendHttpObservation(key, async () => {
          observeMaxSendAdmission('post', '/messages');
          clock += 3_000;
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(stage('http')).toEqual([]);
    expect(stage('final_admission')).toEqual([
      expect.objectContaining({ outcome: 'not_dispatched', durationMs: 3_000 }),
    ]);
  });

  it('preserves attempted timeout evidence even when the observation sink throws', async () => {
    const failure = new Error('private network timeout');
    const request = jest.fn(async () => {
      clock += 1_000;
      throw failure;
    });
    await expect(
      observer(() => {
        throw new Error('sink unavailable');
      }).run(key, () =>
        runWithMaxSendHttpObservation(key, () =>
          performMaxHttpRequest({
            method: 'post',
            path: '/messages',
            sendAttempted: true,
            request,
            assertResponse: () => undefined,
          }),
        ),
      ),
    ).rejects.toBe(failure);
    expect(wasMaxMessageSendAttempted(failure)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not turn a response without a remote ID into acknowledgement evidence', async () => {
    const scope = observer();
    await scope.run(key, async () => {
      await send();
      observeMaxSendAcknowledgement(key, false);
    });
    scope.observeRecipientReceipt();
    expect(stage('send_acknowledgement')[0]).toMatchObject({ outcome: 'remote_id_missing' });
    expect(stage('acknowledgement_to_recipient')[0]).toMatchObject({
      outcome: 'source_unavailable',
      durationMs: null,
    });
  });

  it('does not manufacture transport or acknowledgement clocks for recovered receipts', async () => {
    const scope = observer();
    await scope.run(key, async () => 'saved-remote');
    scope.observeRecipientReceipt();
    expect(stage('http')).toEqual([]);
    expect(stage('acknowledgement_to_recipient')[0]).toMatchObject({
      outcome: 'source_unavailable',
      durationMs: null,
    });
  });

  it('isolates concurrent action scopes, excludes nested actions and observes each actual retry', async () => {
    const other: Observation[] = [];
    await Promise.all([
      observer().run(key, async () => {
        await send('different-action');
        await send();
        await send();
      }),
      observer((value) => other.push(value)).run('parallel-action', () => send('parallel-action')),
    ]);
    expect(stage('http')).toHaveLength(2);
    expect(other.filter((value) => value.stage === 'http')).toHaveLength(1);
  });

  it('excludes a different-key SEND nested inside the active transport callback', async () => {
    await observer().run(key, () =>
      runWithMaxSendHttpObservation(key, async () => {
        observeMaxSendAdmission('post', '/messages');
        await send('nested-action', 3_000);
        expect(observations).toEqual([]);
        await performMaxHttpRequest({
          method: 'post',
          path: '/messages',
          sendAttempted: true,
          request: async () => {
            clock += 1_000;
            return { status: 200, data: { message_id: 'private-outer-remote' } };
          },
          assertResponse: () => undefined,
        });
        observeMaxSendAcknowledgement(key, true);
      }),
    );
    expect(stage('http')).toEqual([
      expect.objectContaining({ durationMs: 1_000, outcome: 'response_received' }),
    ]);
    expect(stage('final_admission')).toEqual([
      expect.objectContaining({ durationMs: 4_000, outcome: 'admitted' }),
    ]);
    expect(stage('send_acknowledgement')).toHaveLength(1);
  });

  it('keeps settled receipt clocks immutable when detached work retains an old context', async () => {
    let release!: () => void;
    let detached!: Promise<void>;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope = observer();
    await scope.run(key, async () => {
      await send();
      observeMaxSendAcknowledgement(key, true);
      beginMaxSendLedgerObservation(key)('exact_readback');
      detached = gate.then(async () => {
        await send();
        beginMaxSendLedgerObservation(key)('cas_committed');
      });
    });
    clock += 250;
    const observationCount = observations.length;
    release();
    await detached;
    expect(observations).toHaveLength(observationCount);
    scope.observeRecipientReceipt();
    expect(stage('ledger_persistence')[0]).toMatchObject({ outcome: 'exact_readback' });
    expect(stage('acknowledgement_to_recipient')[0]).toMatchObject({ durationMs: 1_250 });
  });
});
