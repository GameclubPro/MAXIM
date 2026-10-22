import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  buildMutationTunnelPath,
  fetchMutationWithTunnel,
} from '../src/lib/api/transport-mutation-tunnel';

test('chunks a compressible oversized UTF-8 body even when its compressed URL would fit', async () => {
  const body = JSON.stringify({ text: 'я'.repeat(70 * 1024) });
  assert.ok(body.length < 128 * 1024);
  assert.ok(Buffer.byteLength(body, 'utf8') > 128 * 1024);
  assert.ok(gzipSync(body).toString('base64url').length < 7_000);
  assert.equal(
    await buildMutationTunnelPath('/networks/settings/preview', { method: 'POST', body }),
    null,
  );
  const chunks = new Map<number, Buffer>();
  let commits = 0;
  const result = await fetchMutationWithTunnel(
    'https://major-maksimov.ru/api/v1',
    '/networks/settings/preview',
    'auth-data',
    { method: 'POST', body, timeoutMs: 1_234 },
    async (apiBase, path, authInitData, init) => {
      const query = new URL(path, apiBase).searchParams;
      assert.equal(query.get('path'), '/networks/settings/preview');
      assert.equal(query.get('method'), 'POST');
      assert.equal(query.get('body'), null);
      assert.equal(query.get('bodyGzip'), null);
      assert.equal(authInitData, 'auth-data');
      assert.equal(init?.timeoutMs, 1_234);
      if (query.get('commit') === '1') {
        commits += 1;
        assert.equal(chunks.size, Number(query.get('chunkCount')));
        const received = Buffer.concat(
          [...chunks.entries()].sort(([left], [right]) => left - right).map(([, chunk]) => chunk),
        );
        assert.equal(received.toString('utf8'), body);
      } else {
        assert.notEqual(query.get('chunk'), null);
        chunks.set(Number(query.get('chunkIndex')), Buffer.from(query.get('chunk')!, 'base64url'));
      }
      return { apiBase, response: new Response(null, { status: 204 }) };
    },
  );
  assert.equal(result?.response.status, 204);
  assert.equal(commits, 1);
  assert.ok(chunks.size > 1);
});

test('keeps a body at the server decoded limit eligible for the normal compressed tunnel', async () => {
  const body = JSON.stringify({ text: 'a'.repeat(128 * 1024 - 11) });
  assert.equal(Buffer.byteLength(body, 'utf8'), 128 * 1024);
  const path = await buildMutationTunnelPath('/networks/settings/preview', {
    method: 'POST',
    body,
  });
  assert.notEqual(path, null);
  assert.notEqual(new URL(path!, 'https://major-maksimov.ru').searchParams.get('bodyGzip'), null);
});
