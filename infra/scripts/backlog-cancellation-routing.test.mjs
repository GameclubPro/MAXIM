import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  readBacklogCancellationInput,
  runBacklogCancellationHost,
} from './backlog-cancellation-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const host = fileURLToPath(new URL('./backlog-cancellation-host.mjs', import.meta.url));
const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/backlog-cancellation-v2-contract.json', import.meta.url),
    'utf8',
  ),
);
const start = connector.indexOf('validate_backlog_request() {');
const end = connector.indexOf('\ncancel_webhook_backlog() {', start);
assert.ok(start >= 0 && end > start);
const validation = connector.slice(start, end);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const bytes = (value) => `${JSON.stringify(canonical(value))}\n`;

test('bounded host stdin rejects oversize and malformed UTF-8 without consuming unbounded memory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-input-'));
  try {
    for (const [name, value, accepted] of [
      ['valid', Buffer.from(bytes(fixture.validApply)), true],
      ['bom-preserved', Buffer.from(`\uFEFF${bytes(fixture.validApply)}`), true],
      ['empty', Buffer.alloc(0), false],
      ['oversize', Buffer.alloc(16 * 1024 + 1, 32), false],
      ['utf8', Buffer.from([0xc3, 0x28]), false],
    ]) {
      const path = join(directory, name);
      writeFileSync(path, value);
      const fd = openSync(path, 'r');
      try {
        if (accepted) assert.equal(readBacklogCancellationInput(fd), value.toString());
        else assert.throws(() => readBacklogCancellationInput(fd));
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('connector validates exact private v1/apply/nomination before GitHub and SSH', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-connector-'));
  const legacy = Object.fromEntries(
    ['id', 'cutoff', 'sourceSha', 'imageId'].map((key) => [key, fixture.validApply[key]]),
  );
  try {
    for (const [value, mode, accepted, prefix = ''] of [
      [legacy, 'apply', true],
      [fixture.validApply, 'apply', true],
      [fixture.validNomination, 'preview', true],
      [fixture.validNomination, 'apply', false],
      [fixture.validApply, 'preview', false],
      [{ ...fixture.validNomination, version: 3 }, 'preview', false],
      [{ ...fixture.validNomination, force: true }, 'preview', false],
      [{ ...fixture.validApply, previewSha256: 'PRIVATE_SECRET_MARKER' }, 'apply', false],
      [fixture.validApply, 'apply', false, '\uFEFF'],
      [fixture.validNomination, 'preview', false, '\uFEFF'],
    ]) {
      const path = join(directory, 'request.json');
      writeFileSync(path, `${prefix}${bytes(value)}`, { mode: 0o600 });
      const result = spawnSync(
        'bash',
        [
          '-c',
          `${validation}\nvalidate_backlog_request "$1" "$2" "$3"`,
          'validate',
          path,
          fixture.validApply.sourceSha,
          mode,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, ROOT_DIR: root },
        },
      );
      assert.equal(result.status, accepted ? 0 : 2, result.stderr);
      assert.equal(result.stdout, accepted ? bytes(value) : '');
      assert.ok(!result.stderr.includes('PRIVATE_SECRET_MARKER'));
    }
    for (const [name, following] of [
      ['cancel_webhook_backlog', 'preview_webhook_backlog'],
      ['preview_webhook_backlog', 'legacy_cold_recovery'],
    ]) {
      const body = connector.slice(
        connector.indexOf(`${name}() {`),
        connector.indexOf(`\n${following}() {`),
      );
      assert.ok(body.indexOf('validate_backlog_request ') < body.indexOf('assert-green.mjs'));
      assert.ok(body.indexOf('assert-green.mjs') < body.indexOf('remote_exec '));
      assert.match(body, /validated_request="\$\(validate_backlog_request /);
      assert.match(body, /printf '%s\\n' "\$validated_request" \| remote_exec /);
      assert.ok(!body.includes('<"$request_file"'));
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('the broad legacy continuation refuses scoped requests before a runtime or store call', async () => {
  await assert.rejects(runBacklogCancellationHost(fixture.validApply, true), /scoped controller/);
  const result = spawnSync(process.execPath, [host, '--resume-pending'], {
    input: bytes(fixture.validApply),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /preserve the exact operation/);
});

test('connector sends the validated bytes even if the original file changes during the CI wait', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-pinned-input-'));
  const functions = connector.slice(
    connector.indexOf('cancel_webhook_backlog() {'),
    connector.indexOf('\nlegacy_cold_recovery() {'),
  );
  try {
    for (const [entrypoint, value] of [
      ['cancel_webhook_backlog', fixture.validApply],
      ['preview_webhook_backlog', fixture.validNomination],
    ]) {
      const path = join(directory, 'request.json');
      writeFileSync(path, bytes(value), { mode: 0o600 });
      const script = `${validation}\n${functions}\n
git() { printf '%s\\n' "$TEST_SOURCE_SHA"; }
node() {
  if [[ "$1" == "$ROOT_DIR/scripts/ci/assert-green.mjs" ]]; then
    printf '%s\\n' 'changed-during-ci' > "$TEST_REQUEST_PATH"
  else
    command node "$@"
  fi
}
shell_quote_args() { printf '%s' 'mock-remote'; }
remote_exec() { cat; }
"$1" "$2"
`;
      const result = spawnSync(
        'bash',
        ['-euo', 'pipefail', '-c', script, 'pinned', entrypoint, path],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            ROOT_DIR: root,
            TEST_SOURCE_SHA: value.sourceSha,
            TEST_REQUEST_PATH: path,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(path, 'utf8'), 'changed-during-ci\n');
      assert.equal(result.stdout, bytes(value));
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
