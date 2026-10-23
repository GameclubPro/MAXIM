import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertCommercialLlmContainer,
  assertCommercialLlmReceipt,
  checkCommercialLlmCapacity,
  COMMERCIAL_LLM_RUNTIME as pin,
  commercialLlmSyntheticRequest,
  patchCommercialLlmEnvironment,
  validateCommercialLlmSyntheticResponse,
} from './commercial-llm-runtime.mjs';

const root = resolve(import.meta.dirname, '../..');
const compose = JSON.parse(
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.example',
      '-p',
      'infra',
      '-f',
      'infra/docker-compose.yml',
      '--profile',
      'commercial-llm',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MAXIM_COMPOSE_SERVICE_ENV_FILE: '../.env.example' },
    },
  ),
);
const service = compose.services[pin.service];

function container() {
  return {
    Id: 'a'.repeat(64),
    Image: pin.imageId,
    Config: {
      Image: service.image,
      User: service.user,
      Entrypoint: ['/app/llama-server'],
      Labels: {
        ...service.labels,
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': pin.service,
      },
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'LLAMA_ARG_HOST=0.0.0.0',
        'LLAMA_ARG_PORT=8080',
      ],
      Cmd: service.command,
    },
    State: { Running: true, Health: { Status: 'healthy' } },
    HostConfig: {
      ReadonlyRootfs: service.read_only,
      Init: service.init,
      NanoCpus: service.cpus * 1e9,
      CpuShares: service.cpu_shares,
      Memory: Number(service.mem_limit),
      MemorySwap: Number(service.memswap_limit),
      PidsLimit: service.pids_limit,
      CapDrop: service.cap_drop,
      SecurityOpt: service.security_opt,
      PortBindings: {},
      Privileged: false,
      Tmpfs: { '/tmp': 'size=64m,mode=1777,uid=1000,gid=1000' },
    },
    NetworkSettings: { Networks: { infra_commercial_llm_internal: {} } },
    Mounts: service.volumes.map((mount) => ({
      Type: mount.type,
      Source: mount.source,
      Destination: mount.target,
      RW: !mount.read_only,
    })),
  };
}

test('production inference stays optional, private and limited to its single background client', () => {
  assert.deepEqual(service.profiles, ['commercial-llm']);
  assert.equal(service.image, pin.imageRef);
  assert.deepEqual(Object.keys(service.networks), ['commercial_llm_internal']);
  assert.equal(compose.networks.commercial_llm_internal.internal, true);
  assert.equal(service.ports, undefined);
  assert.equal(service.env_file, undefined);
  assert.equal(service.secrets, undefined);
  assert.equal(service.depends_on, undefined);
  assert.equal(service.cpus, 4);
  assert.equal(Number(service.mem_limit), 24 * 1024 ** 3);
  assert.equal(service.memswap_limit, service.mem_limit);
  const peers = Object.entries(compose.services)
    .filter(([, value]) => Object.hasOwn(value.networks ?? {}, 'commercial_llm_internal'))
    .map(([key]) => key)
    .sort();
  assert.deepEqual(peers, ['api-moderation-background', pin.service].sort());
  assert.equal(
    compose.services['api-moderation-background'].environment.COMMERCIAL_LLM_SHADOW_ENABLED,
    'false',
  );
  assert.equal(
    compose.services['api-moderation-background'].environment.COMMERCIAL_LLM_ENDPOINT,
    'http://gemma-commercial-shadow:8080',
  );
  assert.equal(assertCommercialLlmContainer(container()), 'a'.repeat(64));
});

test('runtime attestation refuses wrong source, public exposure, secret inheritance and relaxed containment', () => {
  const defects = [
    (value) => {
      value.Image = `sha256:${'0'.repeat(64)}`;
    },
    (value) => {
      value.Config.Env.push('DATABASE_URL=redacted');
    },
    (value) => {
      value.HostConfig.NanoCpus = 8e9;
    },
    (value) => {
      value.HostConfig.MemorySwap = -1;
    },
    (value) => {
      value.HostConfig.PidsLimit = -1;
    },
    (value) => {
      value.HostConfig.ReadonlyRootfs = false;
    },
    (value) => {
      value.HostConfig.CapDrop = [];
    },
    (value) => {
      value.HostConfig.SecurityOpt = [];
    },
    (value) => {
      value.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] };
    },
    (value) => {
      value.NetworkSettings.Networks.infra_default = {};
    },
    (value) => {
      value.Mounts[0].RW = true;
    },
    (value) => {
      value.Mounts.push({
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
        RW: true,
      });
    },
    (value) => {
      value.Config.Cmd = [...value.Config.Cmd, '--tools', 'all'];
    },
    (value) => {
      value.Config.Cmd = value.Config.Cmd.filter((arg) => arg !== '--no-agent');
    },
    (value) => {
      value.State.Health.Status = 'unhealthy';
    },
  ];
  for (const defect of defects) {
    const value = container();
    defect(value);
    assert.throws(() => assertCommercialLlmContainer(value), /runtime_attestation_refused/u);
  }
});

test('environment switch preserves unrelated dotenv bytes and refuses duplicate authority', () => {
  const original =
    '# literal values\nDATABASE_URL=not printed\nOTHER=value with spaces\nCOMMERCIAL_LLM_SHADOW_ENABLED=false\n';
  const enabled = patchCommercialLlmEnvironment(original, true);
  assert.equal(enabled, original.replace('SHADOW_ENABLED=false', 'SHADOW_ENABLED=true'));
  assert.equal(patchCommercialLlmEnvironment(enabled, true), enabled);
  assert.equal(patchCommercialLlmEnvironment(enabled, false), original);
  assert.equal(
    patchCommercialLlmEnvironment('A=x', true),
    'A=x\nCOMMERCIAL_LLM_SHADOW_ENABLED=true\n',
  );
  assert.throws(
    () =>
      patchCommercialLlmEnvironment(
        'COMMERCIAL_LLM_SHADOW_ENABLED=false\nexport COMMERCIAL_LLM_SHADOW_ENABLED=true\n',
        false,
      ),
    /duplicate/u,
  );
});

test('admission preserves the model download plus independent disk and memory reserves', () => {
  const enough = pin.modelBytes + pin.diskReserveBytes + pin.downloadReserveBytes + 100000;
  assert.equal(
    checkCommercialLlmCapacity({
      paths: [{ availableBytes: enough }, { availableBytes: enough }],
      availableMemoryBytes: pin.minimumAvailableMemoryBytes,
      needsDownload: true,
    }).artifactBytes,
    pin.modelBytes + pin.templateBytes + pin.licenseBytes,
  );
  assert.throws(
    () =>
      checkCommercialLlmCapacity({
        paths: [{ availableBytes: enough }, { availableBytes: pin.diskReserveBytes }],
        availableMemoryBytes: pin.minimumAvailableMemoryBytes,
        needsDownload: true,
      }),
    /disk_reserve/u,
  );
  assert.throws(
    () =>
      checkCommercialLlmCapacity({
        paths: [{ availableBytes: enough }, { availableBytes: enough }],
        availableMemoryBytes: pin.minimumAvailableMemoryBytes - 1,
        needsDownload: false,
      }),
    /memory_reserve/u,
  );
});

test('synthetic smoke is closed and checks complete bounded JSON, without asserting classifier quality', () => {
  const request = commercialLlmSyntheticRequest();
  assert.equal(request.model, pin.alias);
  assert.equal(request.stream, false);
  assert.equal(request.response_format.json_schema.strict, true);
  const valid = {
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            classification: 'NOT_COMMERCIAL',
            reasonCodes: ['ORDINARY_DISCUSSION'],
          }),
        },
      },
    ],
  };
  assert.doesNotThrow(() => validateCommercialLlmSyntheticResponse(valid));
  for (const response of [
    {},
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '{"classification":"COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"]}',
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content:
              '{"classification":"NOT_COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"],"extra":true}',
          },
        },
      ],
    },
  ])
    assert.throws(() => validateCommercialLlmSyntheticResponse(response));
});

test('receipts retain exact model and upstream image provenance', () => {
  const receipt = {
    schemaVersion: 1,
    sourceSha: 'f'.repeat(40),
    installedAt: new Date().toISOString(),
    containerId: 'a'.repeat(64),
    state: 'installed',
    imageRef: pin.imageRef,
    imageId: pin.imageId,
    modelSha256: pin.modelSha256,
    modelBytes: pin.modelBytes,
    templateSha256: pin.templateSha256,
    modelManifestSha256: pin.modelManifestSha256,
    licenseSha256: pin.licenseSha256,
    upstreamRevision: pin.upstreamRevision,
    upstreamVersion: pin.upstreamVersion,
    smoke: 'closed-synthetic-json-v1',
  };
  assert.equal(assertCommercialLlmReceipt(receipt), receipt);
  assert.throws(
    () => assertCommercialLlmReceipt({ ...receipt, modelSha256: '0'.repeat(64) }),
    /receipt_refused/u,
  );
  assert.throws(
    () => assertCommercialLlmReceipt({ ...receipt, imageRef: 'ghcr.io/ggml-org/llama.cpp:server' }),
    /receipt_refused/u,
  );
});

test('production mutators keep exact-green admission and the persistent protected lock', () => {
  const wrapper = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const host = readFileSync(resolve(root, 'infra/scripts/vps-commercial-llm.sh'), 'utf8');
  assert.match(wrapper, /node "\$ROOT_DIR\/scripts\/ci\/assert-green\.mjs" "\$target_sha"/u);
  assert.match(wrapper, /commercial-llm\)\s+commercial_llm "\$@"/u);
  assert.match(
    host,
    /acquire_deploy_lock[\s\S]+maxim_require_ordinary_effect_authority[\s\S]+require_deploy_lock/u,
  );
  assert.doesNotMatch(host, /FLUSH|prune|remove-orphans|force-recreate/u);
});
