import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const publicSmokeLibrary = fileURLToPath(new URL('./lib/nginx-public-smoke.sh', import.meta.url));

function runMockedPublicSmoke(lines, extraEnv = {}) {
  return spawnSync('bash', ['-c', lines.join('\n')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PUBLIC_SMOKE_LIBRARY: publicSmokeLibrary,
      ...extraEnv,
    },
  });
}

test('public smoke never accepts headers from a failed earlier attempt', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'maxim-nginx-public-smoke-'));
  const counterPath = join(tempDir, 'counter');
  writeFileSync(counterPath, '0\n');

  try {
    const result = runMockedPublicSmoke(
      [
        'set -euo pipefail',
        'source "$PUBLIC_SMOKE_LIBRARY"',
        'curl() {',
        '  count="$(cat "$MOCK_COUNTER")"',
        '  count=$((count + 1))',
        '  printf "%s\\n" "$count" >"$MOCK_COUNTER"',
        '  if [[ "$count" -eq 1 ]]; then',
        "    printf 'HTTP/2 200\\r\\nx-maxim-ingress: webhook\\r\\n\\r\\nMAXIM_HTTP_STATUS:200'",
        '    return 28',
        '  fi',
        "  printf 'HTTP/2 500\\r\\nx-maxim-ingress: webhook\\r\\n\\r\\nMAXIM_HTTP_STATUS:500'",
        '}',
        'maxim_begin_public_nginx_smoke 10 3 1 1 0',
        'maxim_verify_public_nginx_route "example.test" "/health" "200" "webhook" "" 0',
      ],
      { MOCK_COUNTER: counterPath },
    );

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(counterPath, 'utf8').trim(), '3');
    assert.match(result.stderr, /assertion=status:200/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('public smoke requires the final exact status as well as the ingress header', () => {
  const failed = runMockedPublicSmoke([
    'set -euo pipefail',
    'source "$PUBLIC_SMOKE_LIBRARY"',
    'curl() {',
    "  printf 'HTTP/2 500\\r\\nx-maxim-ingress: admin\\r\\n\\r\\nMAXIM_HTTP_STATUS:500'",
    '}',
    'maxim_begin_public_nginx_smoke 10 2 1 1 0',
    'maxim_verify_public_nginx_route "example.test" "/metrics" "401" "admin" "" 0',
  ]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /assertion=status:401/u);

  const passed = runMockedPublicSmoke([
    'set -euo pipefail',
    'source "$PUBLIC_SMOKE_LIBRARY"',
    'curl() {',
    "  printf 'HTTP/2 401\\r\\nx-maxim-ingress: admin\\r\\n\\r\\nMAXIM_HTTP_STATUS:401'",
    '}',
    'maxim_begin_public_nginx_smoke 10 2 1 1 0',
    'maxim_verify_public_nginx_route "example.test" "/metrics" "401" "admin" "" 0',
  ]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /Public smoke passed: example\.test\/metrics/u);
});

test('public smoke validates only the final HTTP response block', () => {
  const result = runMockedPublicSmoke([
    'set -euo pipefail',
    'source "$PUBLIC_SMOKE_LIBRARY"',
    'curl() {',
    "  printf 'HTTP/1.1 200 Connection established\\r\\n\\r\\nHTTP/2 500\\r\\nx-maxim-ingress: webhook\\r\\n\\r\\nMAXIM_HTTP_STATUS:500'",
    '}',
    'maxim_begin_public_nginx_smoke 10 2 1 1 0',
    'maxim_verify_public_nginx_route "example.test" "/health" "200" "webhook" "" 0',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assertion=status:200/u);
});

test('public smoke compares Location values case-sensitively', () => {
  const result = runMockedPublicSmoke([
    'set -euo pipefail',
    'source "$PUBLIC_SMOKE_LIBRARY"',
    'curl() {',
    "  printf 'HTTP/2 308\\r\\nLocation: HTTPS://MAJOR-MAKSIMOV.RU/APP/\\r\\nStrict-Transport-Security: max-age=31536000\\r\\nX-Content-Type-Options: nosniff\\r\\nReferrer-Policy: strict-origin-when-cross-origin\\r\\n\\r\\nMAXIM_HTTP_STATUS:308'",
    '}',
    'maxim_begin_public_nginx_smoke 10 2 1 1 0',
    'maxim_verify_public_nginx_route "example.test" "/app/" "308" "" "https://major-maksimov.ru/app/" 1',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assertion=location:https:\/\/major-maksimov\.ru\/app\//u);
});

test('public smoke shares one bounded deadline across route checks', () => {
  const source = readFileSync(publicSmokeLibrary, 'utf8');
  assert.match(source, /DEADLINE_AT=\$\(\(SECONDS \+ deadline_seconds\)\)/u);
  assert.match(
    source,
    /remaining_seconds=\$\(\(MAXIM_PUBLIC_NGINX_SMOKE_DEADLINE_AT - SECONDS\)\)/u,
  );
  assert.match(source, /--max-time "\$\{attempt_timeout_seconds\}"/u);
  assert.doesNotMatch(source, /--retry(?:-|\s)/u);
});
