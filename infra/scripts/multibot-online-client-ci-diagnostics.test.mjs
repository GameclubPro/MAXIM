import assert, { AssertionError } from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  formatMultibotClientCiFailure,
  MultibotClientCiObservationTimeoutError,
} from './multibot-online-client-ci-fixture.mjs';

const execute = promisify(execFile);
const secret = 'CI_PRIVATE_PASSWORD_SOURCE_SQL_CLIENT_TAG_SENTINEL';
const failure = (phase, family) =>
  `MULTIBOT_CLIENT_CI_FIXTURE_FAILED stage=IMMUTABLE_PREFIX phase=${phase} family=${family}`;

test('actual CLI assertion failures retain the original stage marker without argument contents', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'multibot-online-client-ci-fixture.mjs'),
      'compose',
      `/private/${secret}`,
      `${secret}\nSELECT password FROM private_data;`,
      `maxim-api:${'a'.repeat(40)}`,
      secret,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'MULTIBOT_CLIENT_CI_FIXTURE_FAILED stage=ADMISSION phase=NONE family=ASSERTION\n',
  );
});

test('real failed commands redact captured streams, command arguments and private environment', async () => {
  const error = await execute(
    process.execPath,
    [
      '-e',
      'process.stdout.write(process.env.CI_DIAGNOSTIC_SECRET); process.stderr.write(process.env.CI_DIAGNOSTIC_SECRET); process.exit(13);',
      secret,
    ],
    { env: { ...process.env, CI_DIAGNOSTIC_SECRET: secret }, timeout: 5000 },
  ).then(
    () => assert.fail('The fixture command must fail'),
    (error) => error,
  );
  assert.equal(error.stdout, secret);
  assert.equal(error.stderr, secret);
  assert(error.message.includes(secret));
  assert.equal(
    formatMultibotClientCiFailure('IMMUTABLE_PREFIX', 'PERMISSIONS', error),
    failure('PERMISSIONS', 'COMMAND_FAILED'),
  );
});

test('real command timeout and observation deadline remain distinguishable without raw errors', async () => {
  const error = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)', secret], {
    timeout: 50,
    killSignal: 'SIGKILL',
  }).then(
    () => assert.fail('The fixture command must time out'),
    (error) => error,
  );
  assert.equal(error.killed, true);
  assert.equal(error.signal, 'SIGKILL');
  assert.equal(
    formatMultibotClientCiFailure('IMMUTABLE_PREFIX', 'CLIENT_EXIT', error),
    failure('CLIENT_EXIT', 'COMMAND_TIMEOUT'),
  );
  assert.equal(
    formatMultibotClientCiFailure(
      'IMMUTABLE_PREFIX',
      'PRISMA_BACKEND_WAIT',
      new MultibotClientCiObservationTimeoutError(),
    ),
    failure('PRISMA_BACKEND_WAIT', 'OBSERVATION_TIMEOUT'),
  );
});

test('assertion and format errors expose only finite categories, including sensitive assertion values', () => {
  const assertion = new AssertionError({ actual: secret, expected: `/private/${secret}` });
  Object.assign(assertion, {
    stdout: secret,
    stderr: secret,
    env: secret,
    sql: secret,
    tag: secret,
  });
  assert.equal(
    formatMultibotClientCiFailure('IMMUTABLE_PREFIX', 'CLIENT_ATTEST', assertion),
    failure('CLIENT_ATTEST', 'ASSERTION'),
  );
  assert.equal(
    formatMultibotClientCiFailure(
      'IMMUTABLE_PREFIX',
      'PREFIX_VERIFICATION',
      new SyntaxError(secret),
    ),
    failure('PREFIX_VERIFICATION', 'FORMAT'),
  );
});

test('unknown phases, stages and error codes cannot inject content or invoke conversions', () => {
  const hostile = {
    toString() {
      assert.fail('Diagnostic labels must never coerce objects');
    },
  };
  for (const unknownPhase of [`OBSERVER_WAIT\n${secret}`, `CLIENT_PREPARE\0${secret}`, hostile])
    assert.equal(
      formatMultibotClientCiFailure('IMMUTABLE_PREFIX', unknownPhase, { code: secret }),
      failure('UNKNOWN', 'UNKNOWN'),
    );
  for (const unknownStage of [`IMMUTABLE_PREFIX\n${secret}`, hostile])
    assert.equal(
      formatMultibotClientCiFailure(unknownStage, 'OBSERVER_WAIT', { code: hostile }),
      'MULTIBOT_CLIENT_CI_FIXTURE_FAILED stage=UNKNOWN phase=NONE family=UNKNOWN',
    );
  assert.equal(
    formatMultibotClientCiFailure(
      'PSQL_CLIENT',
      `PRISMA_BACKEND_WAIT\n${secret}`,
      new Error(secret),
    ),
    'MULTIBOT_CLIENT_CI_FIXTURE_FAILED stage=PSQL_CLIENT phase=NONE family=UNKNOWN',
  );
});

test('failure reporting ignores accessors and hostile metadata even when the error is not an Error', () => {
  let reads = 0;
  const error = {};
  for (const key of [
    'message',
    'stack',
    'stdout',
    'stderr',
    'env',
    'sql',
    'source',
    'tag',
    'code',
    'signal',
    'killed',
  ])
    Object.defineProperty(error, key, {
      get() {
        reads += 1;
        throw new Error(secret);
      },
    });
  assert.equal(
    formatMultibotClientCiFailure('IMMUTABLE_PREFIX', 'CLIENT_PREPARE', error),
    failure('CLIENT_PREPARE', 'UNKNOWN'),
  );
  assert.equal(reads, 0);
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error(secret);
      },
    },
  );
  assert.equal(
    formatMultibotClientCiFailure('IMMUTABLE_PREFIX', 'OBSERVER_WAIT', proxy),
    failure('OBSERVER_WAIT', 'UNKNOWN'),
  );
});
