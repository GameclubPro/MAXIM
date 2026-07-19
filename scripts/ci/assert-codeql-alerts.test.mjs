import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExactCodeqlAnalysis,
  assertNoBlockingCodeqlAlerts,
  listBlockingCodeqlAlerts,
} from './assert-codeql-alerts.mjs';

function response(payload, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => payload,
    text: async () => options.text ?? JSON.stringify(payload),
  };
}

test('queries exact ref for both blocking severities with authenticated pagination', async () => {
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.searchParams.get('severity') === 'high' && url.searchParams.get('page') === '1') {
      return response(firstPage);
    }
    if (url.searchParams.get('severity') === 'high') {
      return response([{ number: 101 }]);
    }
    return response([]);
  };

  const alerts = await listBlockingCodeqlAlerts({
    repository: 'GameclubPro/MAXIM',
    ref: 'refs/pull/18/merge',
    token: 'test-token',
    fetchImpl,
  });

  assert.equal(alerts.length, 101);
  assert.deepEqual(
    requests.map(({ url }) => [
      url.searchParams.get('severity'),
      url.searchParams.get('ref'),
      url.searchParams.get('page'),
    ]),
    [
      ['critical', 'refs/pull/18/merge', '1'],
      ['high', 'refs/pull/18/merge', '1'],
      ['high', 'refs/pull/18/merge', '2'],
    ],
  );
  for (const request of requests) {
    assert.equal(request.init.headers.Authorization, 'Bearer test-token');
  }
});

test('rejects open alerts with actionable rule and path details', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/analyses')) {
      return response([
        {
          commit_sha: 'a'.repeat(40),
          error: '',
          ref: 'refs/heads/main',
        },
      ]);
    }
    return response(
      url.searchParams.get('severity') === 'high'
        ? [
            {
              number: 15,
              rule: { id: 'js/polynomial-redos' },
              most_recent_instance: {
                location: { path: 'apps/api/src/max/max-client.service.ts' },
              },
            },
          ]
        : [],
    );
  };

  await assert.rejects(
    () =>
      assertNoBlockingCodeqlAlerts({
        repository: 'GameclubPro/MAXIM',
        ref: 'refs/heads/main',
        sha: 'a'.repeat(40),
        token: 'test-token',
        fetchImpl,
      }),
    /#15 js\/polynomial-redos \(apps\/api\/src\/max\/max-client\.service\.ts\)/u,
  );
});

test('requires a processed analysis for the exact ref and SHA', async () => {
  const fetchImpl = async () =>
    response([
      {
        commit_sha: 'b'.repeat(40),
        error: '',
        ref: 'refs/heads/main',
      },
    ]);

  await assert.rejects(
    () =>
      assertExactCodeqlAnalysis({
        repository: 'GameclubPro/MAXIM',
        ref: 'refs/heads/main',
        sha: 'a'.repeat(40),
        token: 'test-token',
        fetchImpl,
      }),
    /No processed CodeQL analysis found.*a{40}/u,
  );
});

test('fails closed on missing configuration and GitHub API errors', async () => {
  await assert.rejects(
    () =>
      listBlockingCodeqlAlerts({
        repository: 'invalid',
        ref: 'refs/heads/main',
        token: 'test-token',
      }),
    /Invalid GITHUB_REPOSITORY/u,
  );
  await assert.rejects(
    () =>
      listBlockingCodeqlAlerts({
        repository: 'GameclubPro/MAXIM',
        ref: 'refs/heads/main',
        token: 'test-token',
        fetchImpl: async () => response({}, { ok: false, status: 403, text: 'forbidden' }),
      }),
    /HTTP 403.*forbidden/u,
  );
});
