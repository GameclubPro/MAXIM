import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_SERVICE_POOL_CAPS = {
  'api-ingress': 6,
  'api-admin': 10,
  'api-enqueue': 4,
  'api-moderation': 3,
  'api-moderation-critical': 4,
  'api-moderation-join': 4,
  'api-moderation-realtime-b': 3,
  'api-moderation-realtime-c': 3,
  'api-moderation-realtime-d': 3,
  'api-moderation-background': 2,
  'api-action': 6,
} as const;

const API_SERVICE_POOL_CONNECTION_TIMEOUT_MS = {
  'api-action': 20_000,
} as const satisfies Partial<Record<keyof typeof API_SERVICE_POOL_CAPS, number>>;

const COMPOSE_FILES = [
  ['main', '../../../../infra/docker-compose.yml'],
  ['scale', '../../../../infra/docker-compose.scale.yml'],
] as const;

describe('production compose Prisma pool caps', () => {
  describe.each(COMPOSE_FILES)('%s compose', (_name, composePath) => {
    const compose = readFileSync(resolve(__dirname, composePath), 'utf8');

    it('caps every API role below the Postgres cold-start budget', () => {
      let total = 0;

      for (const [service, expectedCap] of Object.entries(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);
        const cap = readEnvNumber(block, 'PRISMA_PG_POOL_MAX');
        expect(cap).toBe(expectedCap);
        expect(readEnvNumber(block, 'PRISMA_PG_POOL_IDLE_TIMEOUT_MS')).toBe(10_000);
        expect(readEnvNumber(block, 'PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS')).toBe(
          API_SERVICE_POOL_CONNECTION_TIMEOUT_MS[
            service as keyof typeof API_SERVICE_POOL_CONNECTION_TIMEOUT_MS
          ] ?? 5_000,
        );
        total += cap;
      }

      expect(total).toBe(48);
    });

    it('caps the dedicated managed-entities read client separately', () => {
      const adminBlock = readServiceBlock(compose, 'api-admin');

      expect(readEnvNumber(adminBlock, 'MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX')).toBe(6);
    });

    it('keeps webhook outbox enqueue work owned by the enqueue role only', () => {
      for (const service of Object.keys(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);
        const appRole = readEnvString(block, 'APP_ROLE');

        expect(appRole).not.toBe('all');
        expect(appRole === 'enqueue').toBe(service === 'api-enqueue');
      }
    });

    it('persists Redis /data on an explicit named volume', () => {
      const redisBlock = readServiceBlock(compose, 'redis');
      const volumesBlock = readTopLevelVolumesBlock(compose);

      expect(redisBlock).toMatch(/^\s{4}volumes:\n\s{6}- redis_data:\/data\s*$/mu);
      expect(volumesBlock).toMatch(/^\s{2}redis_data:\s*$/mu);
    });
  });
});

describe('production deploy script guards', () => {
  it('keeps shared shell API service topology aligned with production guards', () => {
    const topology = readRepoFile('infra/scripts/lib/deploy-topology.sh');
    const monitor = readRepoFile('infra/scripts/vps-monitor-readonly.sh');

    expect(readShellArray(topology, 'MAXIM_PRODUCTION_API_SERVICES')).toEqual(
      Object.keys(API_SERVICE_POOL_CAPS),
    );
    expect(monitor).toContain('source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"');
    expect(monitor).toContain('SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")');
  });

  it('keeps the legacy deploy script fail-closed before deploy side effects', () => {
    const script = readRepoFile('infra/scripts/deploy.sh');
    const gateCall = lineCallIndex(script, 'require_legacy_deploy_confirmation');

    expect(script).toContain('MAXIM_ALLOW_LEGACY_DEPLOY');
    expect(gateCall).toBeLessThan(lineCallIndex(script, 'ensure_compose_env'));
    expect(gateCall).toBeLessThan(indexOfRequired(script, 'npm ci'));
    expect(gateCall).toBeLessThan(
      indexOfRequired(script, 'docker compose -f infra/docker-compose.yml up'),
    );
  });

  it('serializes main deploys and keeps API recreate waves one-at-a-time', () => {
    const script = readRepoFile('infra/scripts/vps-pull-build-up.sh');
    const lockHelper = readRepoFile('infra/scripts/lib/deploy-lock.sh');
    const lockCall = lineCallIndex(script, 'acquire_deploy_lock');

    expect(script).toContain('source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"');
    expect(lockHelper).toContain(
      'DEPLOY_LOCK_DIR="${MAXIM_DEPLOY_LOCK_DIR:-/tmp/maxim-main-deploy.lock}"',
    );
    expect(lockHelper).toContain('Another runtime deploy or rollback is already running');
    expect(lockCall).toBeLessThan(lineCallIndex(script, 'sync_branch'));
    expect(lockCall).toBeLessThan(indexOfRequired(script, 'docker compose "${COMPOSE_FILES[@]}" build'));
    expect(lockCall).toBeLessThan(lineCallIndex(script, 'recreate_service_wave "worker" \\'));
    expect(script).toContain('batch_size="${MAXIM_DEPLOY_API_RECREATE_BATCH_SIZE:-1}"');
    expect(script).toContain('batch_delay_sec="${MAXIM_DEPLOY_API_RECREATE_BATCH_DELAY_SEC:-5}"');
  });

  it('builds one direct API image without provenance and tags every runtime role', () => {
    const topology = readRepoFile('infra/scripts/lib/deploy-topology.sh');
    const mainDeploy = readRepoFile('infra/scripts/vps-pull-build-up.sh');
    const scaleDeploy = readRepoFile('infra/scripts/vps-pull-build-up-scale.sh');
    const rollback = readRepoFile('infra/scripts/vps-runtime-rollback.sh');
    const composeApiBuild = 'docker compose "${COMPOSE_FILES[@]}" build "${API_SERVICES[@]}"';

    expect(topology).toContain('maxim_topology_build_shared_api_image()');
    expect(topology).toContain(
      'docker buildx build --load --provenance=false -t "$source_image" -f apps/api/Dockerfile .',
    );
    expect(topology).toContain('docker tag "$source_image" "${project_name}-${service}:latest"');
    expect(mainDeploy).toContain('maxim_topology_build_shared_api_image "$MAIN_PROJECT_NAME"');
    expect(scaleDeploy).toContain('maxim_topology_build_shared_api_image "$SCALE_PROJECT_NAME"');
    expect(rollback).toContain('maxim_topology_build_shared_api_image infra');
    expect(mainDeploy).not.toContain(composeApiBuild);
    expect(scaleDeploy).not.toContain(composeApiBuild);
    expect(rollback).not.toContain(composeApiBuild);
  });

  it('prepares scale Redis named volume before stopping conflicting stacks', () => {
    const script = readRepoFile('infra/scripts/vps-pull-build-up-scale.sh');

    expect(script).toContain('source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"');
    expect(script).toContain('SCALE_REDIS_VOLUME="${SCALE_PROJECT_NAME}_redis_data"');
    expect(script).toContain('MAXIM_ALLOW_EMPTY_SCALE_REDIS_DATA');
    expect(script).toContain('redis-cli SAVE');
    expect(script).toContain('docker volume create "$target_volume"');
    expect(lineCallIndex(script, 'acquire_deploy_lock')).toBeLessThan(
      lineCallIndex(script, 'sync_branch'),
    );
    expect(lineCallIndex(script, 'prepare_scale_redis_named_volume')).toBeLessThan(
      lineCallIndex(script, 'stop_conflicting_stacks'),
    );
  });

  it('checks rollback Prisma migration compatibility before switching git refs', () => {
    const script = readRepoFile('infra/scripts/vps-runtime-rollback.sh');

    expect(script).toContain('source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"');
    expect(script).toContain('apps/api/prisma/migrations');
    expect(script).toContain('_prisma_migrations');
    expect(lineCallIndex(script, 'acquire_deploy_lock')).toBeLessThan(
      lineCallIndex(script, 'stop_conflicting_scale_stack'),
    );
    expect(lineCallIndex(script, 'stop_conflicting_scale_stack')).toBeLessThan(
      indexOfRequired(script, 'git switch --detach "$ROLLBACK_REF"'),
    );
    expect(lineCallIndex(script, 'ensure_rollback_migrations_compatible')).toBeLessThan(
      indexOfRequired(script, 'git switch --detach "$ROLLBACK_REF"'),
    );
  });
});

function readServiceBlock(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(
      `\\n  ${escapeRegExp(service)}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nvolumes:|$)`,
      'u',
    ),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose service ${service}`);
  }

  return match[1];
}

function readTopLevelVolumesBlock(compose: string): string {
  const match = compose.match(/\nvolumes:\n([\s\S]*)$/u);

  if (!match?.[1]) {
    throw new Error('Missing top-level compose volumes block');
  }

  return match[1];
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../../..', relativePath), 'utf8');
}

function readEnvNumber(serviceBlock: string, key: string): number {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([0-9]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose env ${key}`);
  }

  return Number(match[1]);
}

function readEnvString(serviceBlock: string, key: string): string {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([^'\\n]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose env ${key}`);
  }

  return match[1].trim();
}

function readShellArray(script: string, variableName: string): string[] {
  const match = new RegExp(
    `^${escapeRegExp(variableName)}=\\(\\n([\\s\\S]*?)^\\)`,
    'mu',
  ).exec(script);

  if (!match?.[1]) {
    throw new Error(`Missing shell array ${variableName}`);
  }

  return Array.from(match[1].matchAll(/^\s+"([^"]+)"\s*$/gmu), ([, item]) => item);
}

function lineCallIndex(script: string, command: string): number {
  const match = new RegExp(`^${escapeRegExp(command)}$`, 'mu').exec(script);

  if (!match) {
    throw new Error(`Missing shell command line: ${command}`);
  }

  return match.index;
}

function indexOfRequired(value: string, needle: string): number {
  const index = value.indexOf(needle);

  if (index === -1) {
    throw new Error(`Missing required text: ${needle}`);
  }

  return index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
