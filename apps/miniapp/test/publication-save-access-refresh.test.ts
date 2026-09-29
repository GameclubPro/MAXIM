import assert from 'node:assert/strict';
import test from 'node:test';
import { savePublicationWithAccessRefresh } from '../src/features/publications/publication-save-access-refresh';
import { ApiRequestError } from '../src/lib/api-request-error';
import type { ApiTransport } from '../src/lib/api/transport';

const operationId = 'a2681ca5-cb95-4600-a869-89bcc414be51';
const stale = (blockerCode = 'bot_access_expired', extra = {}) =>
  new ApiRequestError(
    409,
    JSON.stringify({ code: 'PUBLISHER_SETUP_REQUIRED', blockerCode, ...extra }),
    'Обновляется проверка доступа Публика. Повторите позже.',
  );

function fixture() {
  const calls: { path: string; body: unknown }[] = [];
  const controller = new AbortController();
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return path.endsWith('/refresh-selected')
        ? { accepted: true, queuedCount: 2, operationId }
        : { operationId, state: 'complete', total: 2, completed: 2, failed: 0 };
    },
  } as ApiTransport;
  const targets = [
    { id: 'new-chat', entityType: 'chat' as const },
    { id: 'new-channel', entityType: 'channel' as const },
  ];
  let refreshing = 0;
  return {
    api,
    calls,
    controller,
    targets,
    options: {
      api,
      targets,
      signal: controller.signal,
      onRefreshing: () => {
        refreshing += 1;
      },
    },
    get refreshing() {
      return refreshing;
    },
  };
}

test('fresh access saves once without refreshing', async () => {
  const f = fixture();
  assert.equal(
    await savePublicationWithAccessRefresh({ ...f.options, save: async () => 'saved' }),
    'saved',
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.refreshing, 0);
});

for (const blocker of ['bot_access_expired', 'bot_access_unconfirmed']) {
  test(`${blocker}: checks the submitted selection and retries the same request once`, async () => {
    const f = fixture();
    const request = {
      requestId: 'stable-key',
      expectedRevision: 12,
      text: 'Исходный текст',
      at: '2030-01-01T12:00:00Z',
    };
    const attempts: unknown[] = [];
    const result = await savePublicationWithAccessRefresh({
      ...f.options,
      save: async () => {
        attempts.push(request);
        if (attempts.length === 1) throw stale(blocker);
        assert.equal(f.calls.at(-1)?.path, `/publisher/refresh-operations/${operationId}`);
        return request;
      },
    });
    assert.equal(result, request);
    assert.deepEqual(attempts, [request, request]);
    assert.deepEqual(f.calls[0], {
      path: '/publisher/entities/refresh-selected',
      body: { targets: f.targets },
    });
    assert.equal(f.refreshing, 1);
  });
}

for (const error of [
  stale('policy_disabled'),
  stale('bot_not_admin'),
  stale('write_permission_missing'),
  stale('route_quarantined'),
  stale('publisher_runtime_unavailable'),
  stale('PUBLISHER_ACTOR_ACCESS_REQUIRED'),
  stale('bot_access_expired', { canRecheck: false }),
  new Error('network timeout'),
  new ApiRequestError(
    500,
    JSON.stringify({ code: 'PUBLISHER_SETUP_REQUIRED', blockerCode: 'bot_access_expired' }),
    'server error',
  ),
]) {
  test(`does not retry or refresh unsafe failures: ${error instanceof ApiRequestError ? (error.payload?.blockerCode ?? error.status) : error.message}`, async () => {
    const f = fixture();
    let attempts = 0;
    await assert.rejects(
      savePublicationWithAccessRefresh({
        ...f.options,
        save: async () => {
          attempts += 1;
          throw error;
        },
      }),
      (caught) => caught === error,
    );
    assert.equal(attempts, 1);
    assert.equal(f.calls.length, 0);
  });
}

test('fresh denial or repeated expiry after recheck ends recovery without a loop', async () => {
  for (const blocker of ['bot_not_admin', 'bot_access_expired']) {
    const f = fixture();
    let attempts = 0;
    const denial = stale(blocker);
    await assert.rejects(
      savePublicationWithAccessRefresh({
        ...f.options,
        save: async () => {
          attempts += 1;
          throw attempts === 1 ? stale() : denial;
        },
      }),
      (error) => error === denial,
    );
    assert.equal(attempts, 2);
    assert.equal(f.calls.filter((call) => call.path.endsWith('/refresh-selected')).length, 1);
  }
});

test('closing during refresh prevents deferred publication and retains the operation for resuming', async () => {
  const f = fixture();
  let attempts = 0;
  const request = f.api.request;
  f.api.request = async (...args) => {
    const response = await request(...args);
    if (args[0].includes('/refresh-operations/')) f.controller.abort();
    return response;
  };
  const save = async () => {
    attempts += 1;
    throw stale();
  };
  await assert.rejects(savePublicationWithAccessRefresh({ ...f.options, save }), {
    name: 'AbortError',
  });
  assert.equal(attempts, 1);
  f.api.request = request;
  const resumed = new AbortController();
  let resumedAttempts = 0;
  await savePublicationWithAccessRefresh({
    ...f.options,
    signal: resumed.signal,
    targets: [...f.targets].reverse(),
    save: async () => {
      resumedAttempts += 1;
      if (resumedAttempts === 1) throw stale();
      return 'saved';
    },
  });
  assert.equal(resumedAttempts, 2);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/refresh-selected')).length, 1);
});

test('a different audience does not resume an older audience operation', async () => {
  const f = fixture();
  const request = f.api.request;
  f.api.request = async (...args) => {
    const result = await request(...args);
    f.controller.abort();
    return result;
  };
  await assert.rejects(
    savePublicationWithAccessRefresh({
      ...f.options,
      save: async () => {
        throw stale();
      },
    }),
    { name: 'AbortError' },
  );
  f.api.request = request;
  let attempts = 0;
  await savePublicationWithAccessRefresh({
    ...f.options,
    signal: new AbortController().signal,
    targets: [{ id: 'another-chat', entityType: 'chat' }],
    save: async () => {
      if (++attempts === 1) throw stale();
      return 'saved';
    },
  });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/refresh-selected')).length, 2);
});

for (const state of ['partial', 'unavailable']) {
  test(`failed refresh (${state}) never repeats publication`, async () => {
    const f = fixture();
    const request = f.api.request;
    f.api.request = async (...args) =>
      args[0].includes('/refresh-operations/')
        ? { operationId, state, total: 2, completed: 1, failed: 1 }
        : request(...args);
    let attempts = 0;
    await assert.rejects(
      savePublicationWithAccessRefresh({
        ...f.options,
        save: async () => {
          attempts += 1;
          throw stale();
        },
      }),
    );
    assert.equal(attempts, 1);
  });
}

test('refresh timeout preserves the original post without a second send', async () => {
  const f = fixture();
  const request = f.api.request;
  const now = Date.now;
  f.api.request = async (...args) => {
    if (args[0].includes('/refresh-operations/')) {
      Date.now = () => now() + 121_000;
      return { operationId, state: 'running', total: 2, completed: 0, failed: 0 };
    }
    return request(...args);
  };
  let attempts = 0;
  try {
    await assert.rejects(
      savePublicationWithAccessRefresh({
        ...f.options,
        save: async () => {
          attempts += 1;
          throw stale();
        },
      }),
      /Проверка ещё выполняется/u,
    );
    assert.equal(attempts, 1);
  } finally {
    Date.now = now;
  }
});
