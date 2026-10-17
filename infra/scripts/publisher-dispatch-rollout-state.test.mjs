import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  patchPublisherDispatchEnv,
  patchPublisherTemporalSelectionEnv,
  readPublisherDispatchEnv,
  readPublisherTemporalSelectionEnv,
  assertPublisherTemporalSelectionSource,
  PUBLISHER_PRODUCTION_ROLE_BY_SERVICE,
  verifyPublisherComposeConfig,
  verifyPublisherRuntimeEnvironment,
  verifyPublisherTemporalComposeConfig,
  verifyPublisherTemporalRuntimeEnvironment,
  writeFileAtomic,
} from './publisher-dispatch-rollout-state.mjs';

test('patches only the publisher dispatch assignment and preserves every unrelated byte', () => {
  const original =
    '# production\r\nSECRET="keep = this # exactly"\r\nMAX_PUBLISHER_DISPATCH_ENABLED=false\r\nUNICODE=тест\r\n';
  const patched = patchPublisherDispatchEnv(original, true);
  assert.equal(
    patched,
    '# production\r\nSECRET="keep = this # exactly"\r\nMAX_PUBLISHER_DISPATCH_ENABLED=true\r\nUNICODE=тест\r\n',
  );
  assert.deepEqual(readPublisherDispatchEnv(patched), { configured: true, enabled: true });
});

test('uses the fail-closed false default and appends without rewriting existing contents', () => {
  const original = 'A=one\nB=two';
  assert.deepEqual(readPublisherDispatchEnv(original), { configured: false, enabled: false });
  assert.equal(
    patchPublisherDispatchEnv(original, false),
    'A=one\nB=two\nMAX_PUBLISHER_DISPATCH_ENABLED=false',
  );
});

test('rejects duplicate, ambiguous, oversized, and non-boolean dispatch assignments', () => {
  assert.throws(
    () =>
      patchPublisherDispatchEnv(
        'MAX_PUBLISHER_DISPATCH_ENABLED=false\nMAX_PUBLISHER_DISPATCH_ENABLED=true\n',
        true,
      ),
    /Duplicate dotenv key/u,
  );
  assert.throws(
    () => patchPublisherDispatchEnv('MAX_PUBLISHER_DISPATCH_ENABLED="false"\n', true),
    /must be exactly true or false/u,
  );
  assert.throws(
    () => patchPublisherDispatchEnv(Buffer.alloc(1024 * 1024 + 1, 97), true),
    /at most/u,
  );
  assert.throws(
    () => patchPublisherDispatchEnv(Buffer.from([0xff]), true),
    /encoded data was not valid|encoding/u,
  );
});

test('atomically replaces the dotenv while preserving its mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-env-test-'));
  const path = join(directory, '.env');
  writeFileSync(path, 'A=1\nMAX_PUBLISHER_DISPATCH_ENABLED=false\n');
  chmodSync(path, 0o640);
  writeFileAtomic(path, patchPublisherDispatchEnv(readFileSync(path), true));
  assert.equal(readFileSync(path, 'utf8'), 'A=1\nMAX_PUBLISHER_DISPATCH_ENABLED=true\n');
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test('verifies exact service identity and dispatch parity', () => {
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-publisher',
        APP_ROLE: 'publisher',
        MAX_PUBLISHER_DISPATCH_ENABLED: 'true',
      },
      true,
      'api-publisher',
    ),
    true,
  );
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-publisher',
        APP_ROLE: 'action',
        MAX_PUBLISHER_DISPATCH_ENABLED: 'true',
      },
      true,
      'api-publisher',
    ),
    false,
  );
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-publisher',
        APP_ROLE: 'publisher',
        MAX_PUBLISHER_DISPATCH_ENABLED: 'false',
      },
      'any',
      'api-publisher',
    ),
    true,
  );
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-admin',
        APP_ROLE: 'admin',
      },
      'default-false',
      'api-admin',
    ),
    true,
  );
});

test('requires the exact 14-service Compose topology on one immutable image', () => {
  const image = `maxim-api:${'a'.repeat(40)}`;
  const roleByService = {
    'api-ingress': 'ingress',
    'api-admin': 'admin',
    'api-enqueue': 'enqueue',
    'api-moderation': 'moderation',
    'api-moderation-critical': 'moderation',
    'api-moderation-join': 'moderation',
    'api-moderation-realtime-b': 'moderation',
    'api-moderation-realtime-c': 'moderation',
    'api-moderation-realtime-d': 'moderation',
    'api-moderation-background': 'moderation',
    'api-media-analysis': 'moderation',
    'api-action': 'action',
    'api-publisher': 'publisher',
    'api-message-retention': 'message-retention',
  };
  const services = Object.fromEntries(
    Object.entries(roleByService).map(([service, role]) => [
      service,
      {
        image,
        environment: {
          APP_SERVICE_NAME: service,
          APP_ROLE: role,
          MAX_PUBLISHER_DISPATCH_ENABLED: 'false',
        },
      },
    ]),
  );
  assert.equal(verifyPublisherComposeConfig({ services }, false, image), true);
  services['api-extra'] = {
    image,
    environment: {
      APP_SERVICE_NAME: 'api-extra',
      APP_ROLE: 'action',
      MAX_PUBLISHER_DISPATCH_ENABLED: 'false',
    },
  };
  assert.equal(verifyPublisherComposeConfig({ services }, false, image), false);
});

const selectionKey = 'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT';
const selectionModes = ['off', 'test', '5', '25', '100'];
const selectionImage = `maxim-api:${'b'.repeat(40)}`;

function selectionCompose(mode) {
  return {
    services: Object.fromEntries(
      Object.entries(PUBLISHER_PRODUCTION_ROLE_BY_SERVICE).map(([service, role]) => [
        service,
        {
          image: selectionImage,
          environment: {
            APP_SERVICE_NAME: service,
            APP_ROLE: role,
            MAX_PUBLISHER_DISPATCH_ENABLED: 'true',
            ...(mode === undefined ? {} : { [selectionKey]: mode }),
          },
        },
      ]),
    ),
  };
}

test('reads and patches all finite selection stages without modifying dispatch or other bytes', () => {
  const before =
    '\uFEFF# тест\r\nMAX_PUBLISHER_DISPATCH_ENABLED=true\nSECRET="keep = this # exactly"\r\n';
  const after = '\r\nEMPTY=\r\nLAST=значение';
  for (const mode of selectionModes) {
    const original = `${before}${selectionKey}=off${after}`;
    const patched = patchPublisherTemporalSelectionEnv(Buffer.from(original), mode);
    assert.equal(patched, `${before}${selectionKey}=${mode}${after}`);
    assert.deepEqual(readPublisherTemporalSelectionEnv(patched), { configured: true, mode });
    assert.deepEqual(readPublisherDispatchEnv(patched), { configured: true, enabled: true });
  }
  assert.equal(
    patchPublisherTemporalSelectionEnv(`\uFEFF${selectionKey}=off\r\n`, 'test'),
    `\uFEFF${selectionKey}=test\r\n`,
  );
});

test('missing selection defaults to off and appends without rewriting existing bytes', () => {
  for (const [original, suffix] of [
    ['', `${selectionKey}=test\n`],
    ['A=one\nB=two', `\n${selectionKey}=test`],
    ['A=one\r\n', `${selectionKey}=test\r\n`],
    [`# ${selectionKey}=100\n`, `${selectionKey}=test\n`],
  ]) {
    assert.deepEqual(readPublisherTemporalSelectionEnv(original), {
      configured: false,
      mode: 'off',
    });
    assert.equal(patchPublisherTemporalSelectionEnv(original, 'test'), `${original}${suffix}`);
  }
});

test('selection-shaped content inside unrelated multiline values is never patched', () => {
  for (const quote of ['"', "'", '`']) {
    const unrelated = `SECRET=${quote}private\n${selectionKey}=100\nend${quote}\n`;
    assert.deepEqual(readPublisherTemporalSelectionEnv(unrelated), {
      configured: false,
      mode: 'off',
    });
    assert.equal(
      patchPublisherTemporalSelectionEnv(unrelated, 'test'),
      `${unrelated}${selectionKey}=test\n`,
    );
    const original = `${unrelated}${selectionKey}=off\n`;
    assert.equal(
      patchPublisherTemporalSelectionEnv(original, 'test'),
      `${unrelated}${selectionKey}=test\n`,
    );
  }
  assert.throws(
    () => patchPublisherTemporalSelectionEnv('SECRET="unterminated', 'test'),
    /unterminated quoted value/u,
  );
});

test('refuses malformed selection assignments and invalid patch modes without echoing values', () => {
  const malformed = [
    `${selectionKey}=off\nexport ${selectionKey}=test`,
    `${selectionKey}="off"`,
    `${selectionKey}='test'`,
    `${selectionKey}=`,
    `${selectionKey}=50`,
    `${selectionKey}=on`,
    `${selectionKey}=unknown`,
    `${selectionKey}=test # comment`,
    `${selectionKey}`,
    `${selectionKey}: test`,
    `"${selectionKey}"=test`,
  ];
  for (const contents of malformed) {
    assert.throws(
      () => readPublisherTemporalSelectionEnv(contents),
      /Duplicate dotenv key|exact unquoted mode/u,
    );
    assert.throws(
      () => patchPublisherTemporalSelectionEnv(contents, 'off'),
      /Duplicate dotenv key|exact unquoted mode/u,
    );
  }
  for (const mode of ['50', 'on', 'unknown', 'default-off', ' test', '', 5, null]) {
    assert.throws(() => patchPublisherTemporalSelectionEnv('', mode), /mode must be/u);
  }
  assert.throws(() => readPublisherTemporalSelectionEnv(Buffer.alloc(1024 * 1024 + 1)), /at most/u);
  assert.throws(
    () => readPublisherTemporalSelectionEnv(Buffer.from([0xff])),
    /encoded data was not valid|encoding/u,
  );
  assert.throws(() => readPublisherTemporalSelectionEnv('A=\0'), /NUL/u);
});

test('selection runtime checks require finite mode and exact service identity', () => {
  for (const mode of selectionModes) {
    const env = selectionCompose(mode).services['api-publisher'].environment;
    assert.equal(verifyPublisherTemporalRuntimeEnvironment(env, mode, 'api-publisher'), true);
    assert.equal(
      verifyPublisherTemporalRuntimeEnvironment(
        { ...env, APP_ROLE: 'action' },
        mode,
        'api-publisher',
      ),
      false,
    );
    assert.equal(
      verifyPublisherTemporalRuntimeEnvironment(
        { ...env, APP_SERVICE_NAME: 'api-admin' },
        mode,
        'api-publisher',
      ),
      false,
    );
    assert.equal(
      verifyPublisherTemporalRuntimeEnvironment(
        { ...env, [selectionKey]: '50' },
        mode,
        'api-publisher',
      ),
      false,
    );
  }
  const absent = selectionCompose().services['api-admin'].environment;
  assert.equal(verifyPublisherTemporalRuntimeEnvironment(absent, 'default-off', 'api-admin'), true);
  assert.equal(
    verifyPublisherTemporalRuntimeEnvironment(
      { ...absent, [selectionKey]: 'off' },
      'default-off',
      'api-admin',
    ),
    true,
  );
  assert.equal(verifyPublisherTemporalRuntimeEnvironment(absent, 'off', 'api-admin'), false);
  assert.equal(
    verifyPublisherTemporalRuntimeEnvironment(
      { ...absent, [selectionKey]: 'test' },
      'default-off',
      'api-admin',
    ),
    false,
  );
  assert.throws(
    () => verifyPublisherTemporalRuntimeEnvironment(absent, '50', 'api-admin'),
    /mode must be/u,
  );
  assert.throws(
    () => verifyPublisherTemporalRuntimeEnvironment(absent, 'off', 'other-service'),
    /reviewed publisher topology/u,
  );
});

test('selection Compose checks enforce all 14 roles, one exact image and full flag parity', () => {
  for (const mode of selectionModes)
    assert.equal(
      verifyPublisherTemporalComposeConfig(selectionCompose(mode), mode, selectionImage),
      true,
    );
  assert.equal(
    verifyPublisherTemporalComposeConfig(selectionCompose(), 'default-off', selectionImage),
    true,
  );
  for (const mutate of [
    (config) => {
      delete config.services['api-ingress'];
    },
    (config) => {
      config.services['api-extra'] = config.services['api-admin'];
    },
    (config) => {
      config.services['api-action'].image = `maxim-api:${'c'.repeat(40)}`;
    },
    (config) => {
      config.services['api-publisher'].environment.APP_ROLE = 'action';
    },
    (config) => {
      config.services['api-admin'].environment[selectionKey] = 'off';
    },
    (config) => {
      delete config.services['api-ingress'].environment[selectionKey];
    },
  ]) {
    const config = selectionCompose('test');
    mutate(config);
    assert.equal(verifyPublisherTemporalComposeConfig(config, 'test', selectionImage), false);
  }
  assert.throws(
    () =>
      verifyPublisherTemporalComposeConfig(selectionCompose('test'), 'test', 'maxim-api:latest'),
    /image ref/u,
  );
});

function selectionSources() {
  return {
    schema:
      "PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: z.enum(['off', 'test', '5', '25', '100']).default('off'),",
    compose:
      'services:\n  api-publisher:\n    environment:\n      PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: ${PUBLISHER_TEMPORAL_SELECTION_ROLLOUT:-off}\n  api-action:\n    environment: {}\n',
    runtime: `import { parsePublisherTemporalSelectionRollout } from './publisher-publication-temporal-enrollment';
      get publisherTemporalSelectionRollout() {
        return parsePublisherTemporalSelectionRollout(owner.configService.get('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT'),);
      }`,
    enrollment: `const TEST_CHAT_ID = '-78271094414679';
      const TEST_CHANNEL_ID = '-78271171091799';
      export function parsePublisherTemporalSelectionRollout(value: unknown) {
        return value === 'test' || value === '5' || value === '25' || value === '100' ? value : 'off';
      }
      export function buildPublisherTemporalEnrollment(rollout) {
        const mode = parsePublisherTemporalSelectionRollout(rollout);
        if (mode === 'off') return Prisma.sql\`FALSE\`;
        const cohort = 'publisher-temporal-v1:';
        return mode === 'test' ? Prisma.sql\`target."target_chat_id" = \${TEST_CHAT_ID}
          OR target."target_chat_id" = \${TEST_CHANNEL_ID} AND \${buildTestSiblingAudienceProof()}\` : cohort;
      }`,
    selection: `import { buildPublisherTemporalExecutionDueQuery } from './publisher-publication-temporal-selection';
      import { buildPublisherTemporalEnrollment } from './publisher-publication-temporal-enrollment';
      const rollout = this.context.publisherTemporalSelectionRollout;
      selectPublicationManagedBroadcastDueBatch(this.context.prisma, scheduleModes, limit, dispatchProfile, rollout,);
      if (temporalRollout !== 'off') buildPublisherTemporalExecutionDueQuery({ enrollment: buildPublisherTemporalEnrollment(temporalRollout) });`,
    query:
      'export function buildPublisherTemporalExecutionDueQuery(options) { return "temporal_delivery_page"; }',
  };
}

test('source guard requires the installed configuration, consumer and exact test enrollment', () => {
  assert.equal(assertPublisherTemporalSelectionSource(selectionSources()), true);
  const mutations = [
    ['schema', (value) => value.replace("default('off')", "default('test')")],
    ['compose', (value) => value.replace('api-publisher:', 'api-other:')],
    ['compose', (value) => value.replace(':-off', ':-test')],
    [
      'runtime',
      (value) =>
        value.replace("owner.configService.get('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT')", "'test'"),
    ],
    ['enrollment', (value) => value.replace('-78271171091799', '-12345')],
    ['enrollment', (value) => value.replace('buildTestSiblingAudienceProof()', 'true')],
    [
      'selection',
      (value) =>
        value.replace(
          'enrollment: buildPublisherTemporalEnrollment(temporalRollout)',
          'enrollment: true',
        ),
    ],
    ['query', () => ''],
  ];
  for (const [name, mutate] of mutations) {
    const sources = selectionSources();
    sources[name] = mutate(sources[name]);
    assert.throws(() => assertPublisherTemporalSelectionSource(sources), /source guard failed/u);
  }
  for (const name of ['schema', 'runtime', 'enrollment', 'selection', 'query']) {
    const sources = selectionSources();
    sources[name] = `/* ${sources[name]} */`;
    assert.throws(() => assertPublisherTemporalSelectionSource(sources), /source guard failed/u);
  }
});

const helperPath = join(import.meta.dirname, 'publisher-dispatch-rollout-state.mjs');
function runHelper(args, input) {
  return spawnSync(process.execPath, [helperPath, ...args], { input, encoding: 'utf8' });
}

test('CLI keeps old validators and validates dispatch plus selection from the same input', () => {
  const env = JSON.stringify(selectionCompose('test').services['api-publisher'].environment);
  assert.equal(runHelper(['verify-runtime-env', 'true', 'api-publisher'], env).status, 0);
  assert.equal(runHelper(['verify-runtime-env', 'true', 'api-publisher', 'test'], env).status, 0);
  assert.equal(runHelper(['verify-runtime-env', 'true', 'api-publisher', 'off'], env).status, 1);
  assert.equal(runHelper(['verify-runtime-env', 'false', 'api-publisher', 'test'], env).status, 1);
  assert.equal(runHelper(['verify-selection-runtime-env', 'test', 'api-publisher'], env).status, 0);
  const config = JSON.stringify(selectionCompose('test'));
  assert.equal(runHelper(['verify-compose', 'true', selectionImage], config).status, 0);
  assert.equal(runHelper(['verify-compose', 'true', selectionImage, 'test'], config).status, 0);
  assert.equal(runHelper(['verify-compose', 'true', selectionImage, 'off'], config).status, 1);
  assert.equal(runHelper(['verify-compose', 'false', selectionImage, 'test'], config).status, 1);
  assert.equal(runHelper(['verify-selection-compose', 'test', selectionImage], config).status, 0);
  assert.equal(runHelper(['verify-compose', 'true', selectionImage, '50'], config).status, 2);
});

test('CLI patches selection atomically, preserves permissions, and reads only exact source paths', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-selection-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  const original = 'MAX_PUBLISHER_DISPATCH_ENABLED=true\r\nSECRET=private-value';
  writeFileSync(path, original, { mode: 0o640 });
  assert.equal(runHelper(['read-selection-env', path]).stdout, 'off\n');
  assert.equal(runHelper(['read-selection-env-configured', path]).stdout, 'false\n');
  assert.equal(runHelper(['patch-selection-env', path, 'test']).status, 0);
  assert.equal(readFileSync(path, 'utf8'), `${original}\r\n${selectionKey}=test`);
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.equal(runHelper(['read-selection-env-configured', path]).stdout, 'true\n');
  const invalid = runHelper(['patch-selection-env', path, '50']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.ok(!invalid.stderr.includes('private-value'));
  assert.equal(runHelper(['read-selection-env', path]).stdout, 'test\n');
  const paths = {
    schema: 'apps/api/src/config/env.schema.ts',
    compose: 'infra/docker-compose.yml',
    runtime: 'apps/api/src/admin/admin.service.legacy.ts',
    enrollment: 'apps/api/src/admin/publisher-publication-temporal-enrollment.ts',
    selection: 'apps/api/src/admin/admin-managed-broadcast-due-selection.ts',
    query: 'apps/api/src/admin/publisher-publication-temporal-selection.ts',
  };
  for (const [name, source] of Object.entries(selectionSources())) {
    const sourcePath = join(directory, paths[name]);
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
  }
  assert.equal(runHelper(['verify-selection-source', directory]).status, 0);
  rmSync(join(directory, paths.query));
  assert.equal(runHelper(['verify-selection-source', directory]).status, 2);
});
