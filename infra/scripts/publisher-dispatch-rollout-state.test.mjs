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
  patchPublisherRollupNoopEnv,
  readPublisherRollupNoopEnv,
  assertPublisherRollupNoopSource,
  verifyPublisherRollupNoopComposeConfig,
  verifyPublisherRollupNoopRuntimeEnvironment,
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

function selectionCompose(mode, key = selectionKey) {
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
            ...(mode === undefined ? {} : { [key]: mode }),
          },
        },
      ]),
    ),
  };
}

const modeBoundaries = [
  {
    name: 'selection',
    key: selectionKey,
    read: readPublisherTemporalSelectionEnv,
    patch: patchPublisherTemporalSelectionEnv,
    runtime: verifyPublisherTemporalRuntimeEnvironment,
    compose: verifyPublisherTemporalComposeConfig,
  },
  {
    name: 'rollup',
    key: 'PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT',
    read: readPublisherRollupNoopEnv,
    patch: patchPublisherRollupNoopEnv,
    runtime: verifyPublisherRollupNoopRuntimeEnvironment,
    compose: verifyPublisherRollupNoopComposeConfig,
  },
];
for (const boundary of modeBoundaries) {
  const {
    key: selectionKey,
    read: readPublisherTemporalSelectionEnv,
    patch: patchPublisherTemporalSelectionEnv,
    runtime: verifyPublisherTemporalRuntimeEnvironment,
    compose: verifyPublisherTemporalComposeConfig,
  } = boundary;
  test(`${boundary.name}: reads and patches all finite selection stages without modifying dispatch or other bytes`, () => {
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

  test(`${boundary.name}: missing selection defaults to off and appends without rewriting existing bytes`, () => {
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

  test(`${boundary.name}: selection-shaped content inside unrelated multiline values is never patched`, () => {
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

  test(`${boundary.name}: refuses malformed selection assignments and invalid patch modes without echoing values`, () => {
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
    assert.throws(
      () => readPublisherTemporalSelectionEnv(Buffer.alloc(1024 * 1024 + 1)),
      /at most/u,
    );
    assert.throws(
      () => readPublisherTemporalSelectionEnv(Buffer.from([0xff])),
      /encoded data was not valid|encoding/u,
    );
    assert.throws(() => readPublisherTemporalSelectionEnv('A=\0'), /NUL/u);
  });

  test(`${boundary.name}: selection runtime checks require finite mode and exact service identity`, () => {
    for (const mode of selectionModes) {
      const env = selectionCompose(mode, selectionKey).services['api-publisher'].environment;
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
    const absent = selectionCompose(undefined, selectionKey).services['api-admin'].environment;
    assert.equal(
      verifyPublisherTemporalRuntimeEnvironment(absent, 'default-off', 'api-admin'),
      true,
    );
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

  test(`${boundary.name}: selection Compose checks enforce all 14 roles, one exact image and full flag parity`, () => {
    for (const mode of selectionModes)
      assert.equal(
        verifyPublisherTemporalComposeConfig(
          selectionCompose(mode, selectionKey),
          mode,
          selectionImage,
        ),
        true,
      );
    assert.equal(
      verifyPublisherTemporalComposeConfig(
        selectionCompose(undefined, selectionKey),
        'default-off',
        selectionImage,
      ),
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
      const config = selectionCompose('test', selectionKey);
      mutate(config);
      assert.equal(verifyPublisherTemporalComposeConfig(config, 'test', selectionImage), false);
    }
    assert.throws(
      () =>
        verifyPublisherTemporalComposeConfig(
          selectionCompose('test', selectionKey),
          'test',
          'maxim-api:latest',
        ),
      /image ref/u,
    );
  });
}

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

test('independent reader patches preserve sibling and dispatch value/configured pairs', () => {
  for (const boundary of modeBoundaries) {
    const sibling = modeBoundaries.find((entry) => entry !== boundary);
    for (const mode of [undefined, ...selectionModes]) {
      const before = `\uFEFFOTHER="unchanged\n${boundary.key}=100\n"\r\nMAX_PUBLISHER_DISPATCH_ENABLED=false\n${mode === undefined ? '' : `${sibling.key}=${mode}\r\n`}`;
      const after = boundary.patch(before, 'test');
      assert.equal(after, `${before}${boundary.key}=test\r\n`);
      assert.deepEqual(sibling.read(after), {
        configured: mode !== undefined,
        mode: mode ?? 'off',
      });
      assert.deepEqual(readPublisherDispatchEnv(after), { configured: true, enabled: false });
    }
  }
});

test('combined CLI validates all three values and every retained reader role', () => {
  const rollupKey = modeBoundaries[1].key;
  for (const [selection, rollup] of [
    ['test', 'off'],
    ['off', 'test'],
    ['25', '5'],
  ]) {
    const config = selectionCompose(selection);
    for (const service of Object.values(config.services)) service.environment[rollupKey] = rollup;
    const args = ['verify-compose', 'true', selectionImage, selection, rollup];
    assert.equal(runHelper(args, JSON.stringify(config)).status, 0);
    for (const service of Object.keys(config.services)) {
      const original = config.services[service].environment[rollupKey];
      delete config.services[service].environment[rollupKey];
      assert.equal(runHelper(args, JSON.stringify(config)).status, 1, service);
      config.services[service].environment[rollupKey] = original;
    }
    const environment = JSON.stringify(config.services['api-admin'].environment);
    assert.equal(
      runHelper(['verify-runtime-env', 'true', 'api-admin', selection, rollup], environment).status,
      0,
    );
    assert.equal(
      runHelper(['verify-runtime-env', 'true', 'api-admin', selection, '50'], environment).status,
      2,
    );
    assert.equal(
      runHelper(['verify-compose', 'true', selectionImage, selection, '50'], JSON.stringify(config))
        .status,
      2,
    );
  }
  const absent = JSON.stringify(selectionCompose('test'));
  assert.equal(
    runHelper(['verify-compose', 'true', selectionImage, 'test', 'default-off'], absent).status,
    0,
  );
  assert.equal(
    runHelper(['verify-compose', 'true', selectionImage, 'test', 'off'], absent).status,
    1,
  );
});

const rollupPaths = {
  schema: 'apps/api/src/config/env.schema.ts',
  compose: 'infra/docker-compose.yml',
  runtime: 'apps/api/src/admin/publication.service.ts',
  reader: 'apps/api/src/admin/publication-occurrence-rollup-noop.ts',
};
function rollupSources() {
  return Object.fromEntries(
    Object.entries(rollupPaths).map(([name, path]) => [
      name,
      readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
    ]),
  );
}

test('rollup source guard binds real installed consumer, default-off, proof and after-query clock', () => {
  assert.equal(assertPublisherRollupNoopSource(rollupSources()), true);
  const mutations = [
    [
      'schema',
      (value) =>
        value.replace(
          /(PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT:[\s\S]*?)default\('off'\)/u,
          "$1default('test')",
        ),
    ],
    [
      'compose',
      (value) =>
        value.replace(
          'PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT:-off',
          'PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT:-test',
        ),
    ],
    [
      'runtime',
      (value) =>
        value.replace(
          "configService.get<unknown>('PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT')",
          "'test'",
        ),
    ],
    [
      'runtime',
      (value) =>
        value.replace('this.occurrenceRollupNoop.canSkip(occurrenceId)', 'Promise.resolve(true)'),
    ],
    [
      'reader',
      (value) => value.replace('publisher-occurrence-rollup-noop-v1:', 'publisher-temporal-v1:'),
    ],
    ['reader', (value) => value.replace("if (this.rollout === 'off') return false;", '')],
    ['reader', (value) => value.replace('return snapshot.status === expected', 'return true')],
    [
      'reader',
      (value) => value.replace('rollup_recipient_page AS MATERIALIZED', 'rollup_recipient_page AS'),
    ],
    ...[
      (value) => value.replace('rollup_recipient_keys AS MATERIALIZED', 'rollup_recipient_keys AS'),
      (value) => value.replace('SELECT recipient_key."broadcast_id"', 'SELECT recipient_key.*'),
      (value) =>
        value.replace(
          'recipient_key."broadcast_id" >= saved."id"',
          'recipient_key."broadcast_id" > saved."id"',
        ),
      (value) =>
        value.replace(
          'recipient_key."broadcast_id" >= saved."id"',
          'recipient_key."broadcast_id" = saved."id"',
        ),
      (value) => value.replace('>= saved."id"', '>= occurrence."id"'),
      (value) =>
        value.replace(/^[ \t]*ORDER BY recipient_key[^\n]+\n[ \t]*recipient_key[^\n]+$/mu, ''),
      (value) =>
        value.replace(
          /(ORDER BY recipient_key\."broadcast_id",[^\n]+\n[ \t]*recipient_key\."target_chat_id")/u,
          '$1 DESC',
        ),
      (value) =>
        value.replace(
          /ORDER BY recipient_key\."broadcast_id",[^\n]+\n[ \t]*recipient_key\."target_chat_id"/u,
          (order) => order.replace('recipient_key."target_chat_id"', 'recipient_key."status"'),
        ),
      (value) => value.replace(/^[ \t]*LIMIT 3[ \t]*$/mu, ''),
      (value) => value.replace('LIMIT 3', 'LIMIT 2'),
      (value) => value.replace('LIMIT 3', 'LIMIT 4'),
      (value) =>
        value.replace(
          'WHERE recipient_key."broadcast_id" >= saved."id"',
          `WHERE recipient_key."broadcast_id" >= saved."id" AND recipient_key."status" = 'PENDING'`,
        ),
      (value) =>
        value.replace(
          'WHERE recipient_key."broadcast_id" >= saved."id"',
          'WHERE recipient_key."broadcast_id" >= saved."id" AND recipient_key."occurrence_index" = 1',
        ),
      (value) =>
        value.replace(
          'WHERE recipient_key."broadcast_id" >= saved."id"',
          'WHERE recipient_key."broadcast_id" >= saved."id" AND recipient_key."content_revision_id" = occurrence."content_revision_id"',
        ),
    ].map((mutate) => [
      'reader',
      (value) =>
        value.replace(/WITH rollup_recipient_keys AS MATERIALIZED \([\s\S]*?\n[ \t]*\)/u, mutate),
    ]),
    ...[
      (value) => value.replace('CROSS JOIN LATERAL', 'CROSS JOIN'),
      (value) => value.replace('>= ROW(candidate."broadcast_id"', '> ROW(candidate."broadcast_id"'),
      (value) => value.replace('>= ROW(candidate."broadcast_id"', '= ROW(candidate."broadcast_id"'),
      (value) => value.replace('>= ROW(candidate."broadcast_id"', '>= ROW(saved."id"'),
      (value) =>
        value.replace(/^[ \t]*ORDER BY recipient_saved[^\n]+\n[ \t]*recipient_saved[^\n]+$/mu, ''),
      (value) =>
        value.replace(
          /(ORDER BY recipient_saved\."broadcast_id",[^\n]+\n[ \t]*recipient_saved\."target_chat_id")/u,
          '$1 DESC',
        ),
      (value) => value.replace(/^[ \t]*LIMIT 1[ \t]*$/mu, ''),
      (value) => value.replace('LIMIT 1', 'LIMIT 2'),
      (value) =>
        value.replace(
          'candidate."occurrence_index", candidate."target_chat_id")',
          'candidate."occurrence_index", candidate."target_chat_id") AND recipient_saved."status" = \'PENDING\'',
        ),
      (value) => value.replace(/^[ \t]*AND recipient\."broadcast_id"[^\n]+$/mu, ''),
      (value) => value.replace(/^[ \t]*AND recipient\."occurrence_index"[^\n]+$/mu, ''),
      (value) => value.replace(/^[ \t]*AND recipient\."target_chat_id"[^\n]+$/mu, ''),
      (value) =>
        value.replace(
          'recipient."broadcast_id" = candidate."broadcast_id"',
          'recipient."broadcast_id" >= candidate."broadcast_id"',
        ),
      (value) =>
        value.replace(
          'recipient."broadcast_id" = candidate."broadcast_id"',
          'recipient."broadcast_id" = saved."id"',
        ),
      (value) => value.replace('candidate."occurrence_index"', 'candidate."target_chat_id"'),
      (value) => value.replace('candidate."target_chat_id"', 'saved."id"'),
      (value) => value.replace('candidate."broadcast_id" = saved."id"', 'TRUE'),
      (value) =>
        value.replace(
          'candidate."broadcast_id" = saved."id"',
          'candidate."broadcast_id" >= saved."id"',
        ),
      (value) =>
        value.replace(
          'candidate."broadcast_id" = saved."id"',
          'candidate."broadcast_id" = occurrence."id"',
        ),
      (value) =>
        value.replace(
          'candidate."broadcast_id" = saved."id"',
          'candidate."broadcast_id" = saved."id" OR TRUE',
        ),
    ].map((mutate) => [
      'reader',
      (value) =>
        value.replace(
          /rollup_recipient_page AS MATERIALIZED \([\s\S]*?\n[ \t]*\)\n[ \t]*SELECT COUNT/u,
          mutate,
        ),
    ]),
    ...[
      (value) => value.replace('rollup_envelope_page AS MATERIALIZED', 'rollup_envelope_page AS'),
      (value) => value.replace('LIMIT 3', 'LIMIT 2'),
      (value) => value.replace('envelope."publication_occurrence_id" = occurrence."id"', 'TRUE'),
      (value) =>
        value.replace(
          'envelope."publication_occurrence_id" = occurrence."id"',
          'envelope."publication_occurrence_id" >= occurrence."id"',
        ),
    ].map((mutate) => [
      'reader',
      (value) =>
        value.replace(/WITH rollup_envelope_page AS MATERIALIZED \([\s\S]*?\n[ \t]*\)/u, mutate),
    ]),
    ...[
      (value) => value.replace('CROSS JOIN LATERAL', 'CROSS JOIN'),
      (value) => value.replace(/^[ \t]*OFFSET 0[ \t]*$/mu, ''),
      (value) => value.replace('OFFSET 0', 'OFFSET 1'),
      (value) => value.replace('"id" = envelope_id."id"', '"id" >= envelope_id."id"'),
      (value) => value.replace('"id" = envelope_id."id"', '"id" = occurrence."id"'),
      (value) => value.replace('"id" = envelope_id."id"', '"id" = envelope_id."id" OR TRUE'),
    ].map((mutate) => [
      'reader',
      (value) =>
        value.replace(/FROM rollup_envelope_page AS envelope_id[\s\S]*?\) AS saved/u, mutate),
    ]),
    ['reader', (value) => value.replace('-78271171091799', '-1')],
    ['reader', (value) => value.replace('COUNT(*) BETWEEN 1 AND 2', 'COUNT(*) <= 2')],
    [
      'reader',
      (value) => value.replace('COUNT(*) <= 2 AND COALESCE', 'COUNT(*) <= 3 AND COALESCE'),
    ],
    [
      'reader',
      (value) => value.replace('saved."required_bot_id" = occurrence."required_bot_id"', 'TRUE'),
    ],
    [
      'reader',
      (value) =>
        value.replace(
          'saved."publication_content_revision_id" = occurrence."content_revision_id"',
          'TRUE',
        ),
    ],
    [
      'reader',
      (value) => value.replace('recipient."publication_occurrence_id" = occurrence."id"', 'TRUE'),
    ],
    [
      'reader',
      (value) =>
        value.replace('recipient."content_revision_id" = occurrence."content_revision_id"', 'TRUE'),
    ],
    [
      'reader',
      (value) =>
        value.replace('recipient."required_bot_id" = occurrence."required_bot_id"', 'TRUE'),
    ],
    ['reader', (value) => value.replace('rollup_scope AS MATERIALIZED', 'rollup_scope AS')],
    [
      'reader',
      (value) => value.replace('rollup_occurrence AS MATERIALIZED', 'rollup_occurrence AS'),
    ],
    ...[
      (value) =>
        value.replace(
          'rollup_occurrence_admission AS MATERIALIZED',
          'rollup_occurrence_admission AS',
        ),
      (value) => value.replace('SELECT CASE WHEN (', 'SELECT CASE WHEN TRUE OR ('),
      (value) => value.replace('SELECT reltuples > 0', 'SELECT TRUE'),
      (value) => value.replace('SELECT reltuples > 0', 'SELECT reltuples >= 0'),
      (value) => value.replace('SELECT reltuples > 0', 'SELECT reltuples <= 0'),
      (value) => value.replace('FROM pg_catalog.pg_class', 'FROM pg_class'),
      (value) =>
        value.replace(
          "WHERE oid = 'publication_occurrences'::regclass",
          "WHERE oid = 'managed_broadcasts'::regclass",
        ),
      (value) =>
        value.replace(
          "WHERE oid = 'publication_occurrences'::regclass",
          "WHERE oid >= 'publication_occurrences'::regclass",
        ),
      (value) =>
        value.replace(
          "WHERE oid = 'publication_occurrences'::regclass",
          "WHERE oid = 'publication_occurrences'::regclass OR TRUE",
        ),
      (value) => value.replace('ELSE NULL END AS "id"', 'ELSE ${occurrenceId} END AS "id"'),
      (value) => value.replace('SELECT "id" FROM', 'SELECT * FROM'),
      (value) => value.replace('>= ${occurrenceId}', '> ${occurrenceId}'),
      (value) => value.replace('>= ${occurrenceId}', '= ${occurrenceId}'),
      (value) => value.replace('${occurrenceId}', '${otherOccurrenceId}'),
      (value) => value.replace(/^[ \t]*ORDER BY "id"[ \t]*$/mu, ''),
      (value) => value.replace('ORDER BY "id"', 'ORDER BY "id" DESC'),
      (value) => value.replace('ORDER BY "id"', 'ORDER BY "publication_id"'),
      (value) => value.replace(/^[ \t]*LIMIT 1[ \t]*$/mu, ''),
      (value) => value.replace('LIMIT 1', 'LIMIT 2'),
      (value) =>
        value.replace(
          'WHERE "id" >= ${occurrenceId}',
          `WHERE "id" >= \${occurrenceId} AND "status" = 'IN_PROGRESS'`,
        ),
      (value) =>
        value.replace(
          'WHERE "id" >= ${occurrenceId}',
          `WHERE "id" >= \${occurrenceId} AND "dispatch_profile" = 'PUBLIK_V1'`,
        ),
    ].map((mutate) => [
      'reader',
      (value) =>
        value.replace(
          /WITH rollup_occurrence_admission AS MATERIALIZED \([\s\S]*?\n[ \t]*\), rollup_occurrence_key AS MATERIALIZED/u,
          mutate,
        ),
    ]),
    ...[
      (value) => value.replace('rollup_occurrence_key AS MATERIALIZED', 'rollup_occurrence_key AS'),
      (value) => value.replace('SELECT "id" FROM', 'SELECT * FROM'),
      (value) =>
        value.replace('FROM rollup_occurrence_admission', 'FROM "publication_occurrences"'),
      (value) => value.replace('WHERE "id" IS NOT NULL', ''),
      (value) => value.replace('WHERE "id" IS NOT NULL', 'WHERE "id" IS NULL'),
      (value) => value.replace('WHERE "id" IS NOT NULL', 'WHERE "id" IS NOT NULL OR TRUE'),
    ].map((mutate) => [
      'reader',
      (value) =>
        value.replace(/rollup_occurrence_key AS MATERIALIZED \([\s\S]*?\n[ \t]*\)/u, mutate),
    ]),
    ...[
      (value) => value.replace('CROSS JOIN LATERAL', 'CROSS JOIN'),
      (value) => value.replace('WHERE "id" >= candidate."id"', 'WHERE "id" > candidate."id"'),
      (value) => value.replace('WHERE "id" >= candidate."id"', 'WHERE "id" = candidate."id"'),
      (value) =>
        value.replace('WHERE "id" >= candidate."id"', 'WHERE "id" >= candidate."other_id"'),
      (value) =>
        value.replace('WHERE "id" >= candidate."id"', 'WHERE "id" >= candidate."id" OR TRUE'),
      (value) =>
        value.replace(
          'WHERE "id" >= candidate."id"',
          `WHERE "id" >= candidate."id" AND "status" = 'IN_PROGRESS'`,
        ),
      (value) => value.replace(/^[ \t]*ORDER BY "id"[ \t]*$/mu, ''),
      (value) => value.replace('ORDER BY "id"', 'ORDER BY "id" DESC'),
      (value) => value.replace('ORDER BY "id"', 'ORDER BY "publication_id"'),
      (value) => value.replace(/^[ \t]*LIMIT 1[ \t]*$/mu, ''),
      (value) => value.replace('LIMIT 1', 'LIMIT 2'),
      (value) => value.replace('LIMIT 1', 'OFFSET 0'),
      (value) => value.replace('WHERE occurrence."id" = candidate."id"', ''),
      (value) =>
        value.replace(
          'WHERE occurrence."id" = candidate."id"',
          'WHERE occurrence."id" >= candidate."id"',
        ),
      (value) =>
        value.replace(
          'WHERE occurrence."id" = candidate."id"',
          'WHERE occurrence."id" = candidate."other_id"',
        ),
      (value) =>
        value.replace(
          'WHERE occurrence."id" = candidate."id"',
          'WHERE occurrence."id" = candidate."id" OR TRUE',
        ),
    ].map((mutate) => [
      'reader',
      (value) =>
        value.replace(
          /rollup_occurrence AS MATERIALIZED \([\s\S]*?\n[ \t]*\)\n[ \t]*SELECT occurrence/u,
          mutate,
        ),
    ]),
    ...[
      'WHERE TRUE',
      'WHERE occurrence."id" >= ${occurrenceId}',
      'WHERE publication."id" = ${occurrenceId}',
      'WHERE occurrence."id" = ${otherOccurrenceId}',
      'WHERE occurrence."id" = ${occurrenceId} OR TRUE',
    ].map((replacement) => [
      'reader',
      (value) => value.replace('WHERE occurrence."id" = ${occurrenceId}', replacement),
    ]),
    [
      'reader',
      (value) =>
        value.replace(
          'publication."id" = occurrence."publication_id"',
          'publication."id" = occurrence."id"',
        ),
    ],
    [
      'reader',
      (value) =>
        value.replace('AND occurrence."dispatch_profile"', 'AND publication."dispatch_profile"'),
    ],
    [
      'reader',
      (value) => value.replace('AND occurrence."status" IN', 'AND publication."status" IN'),
    ],
    [
      'reader',
      (value) =>
        value.replace('rollup_linked_envelopes AS MATERIALIZED', 'rollup_linked_envelopes AS'),
    ],
    ['reader', (value) => value.replace('FROM rollup_scope WHERE "enrolled"', 'FROM rollup_scope')],
    ['reader', (value) => value.replace('>= ROW(envelope."id", 1,', '> ROW(envelope."id", 1,')],
    ['reader', (value) => value.replace('>= ROW(envelope."id", 1,', '>= ROW(envelope."id", 2,')],
    ...['SENDING', 'PENDING'].flatMap((status) =>
      [
        (value) =>
          value.replace('rollup_delivery_probe AS MATERIALIZED', 'rollup_delivery_probe AS'),
        (value) => value.replace(/^[ \t]*ORDER BY delivery[^\n]+$/mu, ''),
        (value) => value.replace(/^[ \t]*LIMIT 1[ \t]*$/mu, ''),
        (value) => value.replace('candidate."broadcast_id" = envelope."id"', 'TRUE'),
        (value) =>
          value.replace('candidate."occurrence_index" = 1', 'candidate."occurrence_index" = 2'),
        (value) => value.replace(`candidate."status" = '${status}'`, `candidate."status" = 'SENT'`),
      ].map((mutate) => [
        'reader',
        (value) => {
          const begin = value.indexOf(
            'CASE WHEN scope."enrolled" THEN EXISTS',
            status === 'SENDING' ? 0 : value.indexOf('ELSE FALSE END AS "hasSending"'),
          );
          return value.slice(0, begin) + mutate(value.slice(begin));
        },
      ]),
    ),
    [
      'reader',
      (value) => value.replace(`envelope."status" = 'ACTIVE'::"ManagedBroadcastStatus"`, 'TRUE'),
    ],
    [
      'reader',
      (value) =>
        value
          .replace(
            "    if (this.rollout === 'off') return false;",
            "    const decisionNow = new Date();\n    if (this.rollout === 'off') return false;",
          )
          .replace('      const decisionNow = new Date();', ''),
    ],
  ];
  for (const [name, mutate] of mutations) {
    const sources = rollupSources();
    const mutated = mutate(sources[name]);
    assert.notEqual(mutated, sources[name], `mutation must change ${name}`);
    sources[name] = mutated;
    assert.throws(() => assertPublisherRollupNoopSource(sources), /source guard failed/u, name);
  }
  for (const name of ['schema', 'runtime', 'reader']) {
    const sources = rollupSources();
    sources[name] = `/* ${sources[name]} */`;
    assert.throws(() => assertPublisherRollupNoopSource(sources), /source guard failed/u);
  }
});

test('rollup CLI preserves dotenv permissions and verifies only the installed source paths', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-rollup-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  const original = 'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=test\r\nOTHER=private';
  writeFileSync(path, original, { mode: 0o640 });
  assert.equal(runHelper(['read-rollup-env', path]).stdout, 'off\n');
  assert.equal(runHelper(['read-rollup-env-configured', path]).stdout, 'false\n');
  assert.equal(runHelper(['patch-rollup-env', path, '25']).status, 0);
  assert.equal(readFileSync(path, 'utf8'), `${original}\r\n${modeBoundaries[1].key}=25`);
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.equal(runHelper(['read-rollup-env-configured', path]).stdout, 'true\n');
  for (const [name, source] of Object.entries(rollupSources())) {
    const sourcePath = join(directory, rollupPaths[name]);
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
  }
  assert.equal(runHelper(['verify-rollup-source', directory]).status, 0);
  rmSync(join(directory, rollupPaths.reader));
  assert.equal(runHelper(['verify-rollup-source', directory]).status, 2);
});
