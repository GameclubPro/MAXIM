import {
  beginMaxHttpFailureRequest,
  closeMaxHttpFailureOwner,
  consumeMaxHttpOutcome,
  createMaxHttpFailureOwner,
  mapMaxHttpOutcome,
  maxHttpFailureOutcome,
  maxHttpValueOutcome,
  readMaxHttpFailureAssociation,
  type MaxHttpFailureOwner,
} from './max-http-failure-association';
import { performMaxHttpRequest } from './max-http-request';
import { wasMaxMessageSendAttempted } from './max-mutation-outcome.util';

function request(owner: MaxHttpFailureOwner, eligible = true) {
  return beginMaxHttpFailureRequest(owner, 'delete', 'messages', eligible);
}

describe('Explicit MAX HTTP failure ownership', () => {
  const failure = Object.freeze(new Error('private reused error'));

  it.each([undefined, null, false, 0, '', { kind: 'failure', error: 'business value' }])(
    'preserves raw and mapped successful business value %j',
    async (value) => {
      const owner = createMaxHttpFailureOwner();
      const mapper = jest.fn(() => value);
      const outcome = await performMaxHttpRequest({
        method: 'delete',
        path: '/messages',
        sendAttempted: false,
        association: request(owner),
        request: async () => ({ status: 200, data: value }),
        assertResponse: () => undefined,
      });
      expect(consumeMaxHttpOutcome(owner, mapMaxHttpOutcome(outcome, mapper))).toStrictEqual({
        kind: 'value',
        value,
      });
      expect(mapper).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, null, false, 'private rejection', failure])(
    'preserves an arbitrary adapter thrown value %j',
    async (error) => {
      const owner = createMaxHttpFailureOwner();
      const adapter = jest.fn(() => {
        throw error;
      });
      const outcome = await performMaxHttpRequest({
        method: 'delete',
        path: '/messages',
        sendAttempted: false,
        association: request(owner),
        request: adapter,
        assertResponse: () => undefined,
      });
      const result = consumeMaxHttpOutcome(owner, outcome);
      expect(result).toMatchObject({ kind: 'failure', error });
      if (result.kind !== 'failure') throw new Error('Expected failure');
      expect(result.error).toBe(error);
      expect(readMaxHttpFailureAssociation(result.association)).toStrictEqual({
        method: 'delete',
        endpointKind: 'messages',
        phase: 'adapter_rejection',
        receivedStatusCode: null,
      });
      expect(adapter).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'records only the actually received finite status %j on response rejection',
    async (status) => {
      const owner = createMaxHttpFailureOwner();
      const validator = jest.fn(() => {
        throw failure;
      });
      const outcome = await performMaxHttpRequest({
        method: 'delete',
        path: '/messages',
        sendAttempted: false,
        association: request(owner),
        request: async () => ({ status: status as number, data: false }),
        assertResponse: validator,
      });
      const result = consumeMaxHttpOutcome(owner, outcome);
      expect(result.kind).toBe('failure');
      if (result.kind !== 'failure') throw new Error('Expected failure');
      expect(result.error).toBe(failure);
      expect(readMaxHttpFailureAssociation(result.association)).toMatchObject({
        phase: 'response_rejection',
        receivedStatusCode: status === 200 ? 200 : null,
      });
      expect(validator).toHaveBeenCalledTimes(1);
    },
  );

  it('maps synchronous domain validation once and preserves its exact thrown value', () => {
    for (const error of [undefined, null, false, 'rejected', failure]) {
      const owner = createMaxHttpFailureOwner();
      const mapper = jest.fn(() => {
        throw error;
      });
      const outcome = mapMaxHttpOutcome(maxHttpValueOutcome(request(owner), false, 202), mapper);
      const result = consumeMaxHttpOutcome(owner, outcome);
      if (result.kind !== 'failure') throw new Error('Expected failure');
      expect(result.error).toBe(error);
      expect(readMaxHttpFailureAssociation(result.association)).toMatchObject({
        phase: 'domain_validation',
        receivedStatusCode: 202,
      });
      expect(mapper).toHaveBeenCalledTimes(1);
    }
  });

  it('does not run a domain validator again after a response failure', () => {
    const owner = createMaxHttpFailureOwner();
    const outcome = maxHttpFailureOutcome(request(owner), failure, 'response_rejection', 404);
    const mapper = jest.fn();
    expect(mapMaxHttpOutcome(outcome, mapper)).toBe(outcome);
    expect(mapper).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'invalidates multiple starts independently of settlement order, second first=%j',
    async (secondFirst) => {
      const owner = createMaxHttpFailureOwner();
      const first = request(owner);
      const second = beginMaxHttpFailureRequest(owner, 'get', 'chat_members');
      const outcomes = secondFirst
        ? [
            maxHttpFailureOutcome(second, failure, 'adapter_rejection', null),
            maxHttpFailureOutcome(first, failure, 'adapter_rejection', null),
          ]
        : [
            maxHttpFailureOutcome(first, failure, 'adapter_rejection', null),
            maxHttpFailureOutcome(second, failure, 'adapter_rejection', null),
          ];
      for (const outcome of outcomes) {
        expect(consumeMaxHttpOutcome(owner, outcome)).toStrictEqual({
          kind: 'failure',
          error: failure,
          association: null,
        });
      }
    },
  );

  it('counts an ineligible override start and never lends it or a peer proof', () => {
    const owner = createMaxHttpFailureOwner();
    const first = request(owner);
    const override = request(owner, false);
    for (const handle of [first, override]) {
      expect(
        consumeMaxHttpOutcome(
          owner,
          maxHttpFailureOutcome(handle, failure, 'adapter_rejection', null),
        ),
      ).toMatchObject({ association: null, error: failure });
    }
  });

  it('rejects wrong, closed, consumed and detached owners without changing the error', () => {
    const owner = createMaxHttpFailureOwner();
    const other = createMaxHttpFailureOwner();
    const outcome = maxHttpFailureOutcome(request(owner), failure, 'adapter_rejection', null);
    expect(consumeMaxHttpOutcome(other, outcome)).toMatchObject({ association: null });
    const accepted = consumeMaxHttpOutcome(owner, outcome);
    if (accepted.kind !== 'failure') throw new Error('Expected failure');
    expect(accepted.association).not.toBeNull();
    expect(consumeMaxHttpOutcome(owner, outcome)).toMatchObject({ association: null });
    closeMaxHttpFailureOwner(owner);
    closeMaxHttpFailureOwner(owner);
    expect(
      consumeMaxHttpOutcome(
        owner,
        maxHttpFailureOutcome(request(owner), failure, 'adapter_rejection', null),
      ),
    ).toMatchObject({ association: null, error: failure });

    const closed = createMaxHttpFailureOwner();
    const pending = request(closed);
    closeMaxHttpFailureOwner(closed);
    expect(
      consumeMaxHttpOutcome(
        closed,
        maxHttpFailureOutcome(pending, failure, 'adapter_rejection', null),
      ),
    ).toMatchObject({ association: null, error: failure });
  });

  it('keeps concurrent and nested owners independent even with the same frozen Error', () => {
    const owners = [createMaxHttpFailureOwner(), createMaxHttpFailureOwner()];
    const handles = [
      request(owners[0]),
      beginMaxHttpFailureRequest(owners[1], 'get', 'chat_members'),
    ];
    const outcomes = handles.map((handle) =>
      maxHttpFailureOutcome(handle, failure, 'adapter_rejection', null),
    );
    expect(consumeMaxHttpOutcome(owners[1], outcomes[1])).toMatchObject({
      error: failure,
      association: { method: 'get', endpointKind: 'chat_members' },
    });
    expect(consumeMaxHttpOutcome(owners[0], outcomes[0])).toMatchObject({
      error: failure,
      association: { method: 'delete', endpointKind: 'messages' },
    });
    expect(Object.getOwnPropertySymbols(failure)).toEqual([]);
  });

  it('drops damaged diagnostic proof without replacing a value or domain error', () => {
    const owner = createMaxHttpFailureOwner();
    const outcome = maxHttpValueOutcome(request(owner), false, 200);
    const symbol = Object.getOwnPropertySymbols(outcome)[0];
    Object.defineProperty(outcome, symbol, {
      get: () => {
        throw new Error('diagnostic unavailable');
      },
    });
    const mapper = jest.fn(() => {
      throw failure;
    });
    expect(consumeMaxHttpOutcome(owner, mapMaxHttpOutcome(outcome, mapper))).toStrictEqual({
      kind: 'failure',
      error: failure,
      association: null,
    });
    expect(mapper).toHaveBeenCalledTimes(1);

    const other = createMaxHttpFailureOwner();
    const damaged = new Proxy(request(other), {
      get: () => {
        throw new Error('diagnostic unavailable');
      },
    });
    expect(consumeMaxHttpOutcome(other, maxHttpValueOutcome(damaged, false, 200))).toStrictEqual({
      kind: 'value',
      value: false,
    });
  });

  it('retains the raw path for omitted/undefined association and the prior SEND evidence', async () => {
    for (const options of [{}, { association: undefined }]) {
      const value = { kind: 'failure', error: failure };
      expect(
        await performMaxHttpRequest({
          ...options,
          method: 'post',
          path: '/messages',
          sendAttempted: true,
          request: async () => ({ status: 200, data: value }),
          assertResponse: () => undefined,
        }),
      ).toBe(value);
      const error = new Error('SEND timeout');
      await expect(
        performMaxHttpRequest({
          ...options,
          method: 'post',
          path: '/messages',
          sendAttempted: true,
          request: async () => {
            throw error;
          },
          assertResponse: () => undefined,
        }),
      ).rejects.toBe(error);
      expect(wasMaxMessageSendAttempted(error)).toBe(true);
    }
  });

  it('does not inspect association before invoking the existing adapter', async () => {
    const order: string[] = [];
    const owner = createMaxHttpFailureOwner();
    const handle = request(owner);
    const options = {
      method: 'delete',
      path: '/messages',
      sendAttempted: false,
      get association() {
        order.push('association');
        return handle;
      },
      request: () => {
        order.push('adapter');
        return Promise.resolve({ status: 200, data: true });
      },
      assertResponse: () => order.push('response'),
    };
    expect(consumeMaxHttpOutcome(owner, await performMaxHttpRequest(options))).toEqual({
      kind: 'value',
      value: true,
    });
    expect(order[0]).toBe('adapter');
    expect(order[1]).toBe('response');
  });
});
