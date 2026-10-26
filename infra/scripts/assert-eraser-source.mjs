import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const ERASER_CONNECTION_REQUEST_FLOOR =
  '/var/lib/maxim-deploy/eraser-connection-request-version';

export const ERASER_CONNECTION_REQUEST_CHECKS = Object.freeze({
  'api-shared': [
    [
      'apps/api/src/message-retention/eraser-control.service.ts',
      [
        'ERASER_CONNECTION_REQUEST_VERSION = 1',
        'connectWhenReady: value.connectWhenReady === true',
      ],
    ],
    ['packages/contracts/src/message-retention.ts', ['connectWhenReady', 'connectionRequest']],
  ],
  eraser: [
    [
      'apps/eraser/src/runtime.ts',
      ['ERASER_CONNECTION_REQUEST_VERSION = 1', 'reserveConnections', 'activateConnection'],
    ],
    [
      'apps/eraser/src/store.ts',
      ['eraser_connection_requests', 'clock_timestamp()', 'activateConnection', 'finishConnection'],
    ],
    ['apps/eraser/src/http.ts', ['input.connectWhenReady', 'connectWhenReady']],
    [
      'apps/eraser/migrations/0003-connection-requests.sql',
      ['eraser_connection_requests', 'expires_at', 'policy_revision'],
    ],
  ],
  tooling: [
    [
      'infra/scripts/lib/deploy-topology.sh',
      [
        'maxim_topology_require_eraser_connection_requests()',
        'maxim_topology_require_eraser_connection_requests "$source_sha" all',
        'eraser-connection-request-version',
        '--validate-connection-request-floor',
        '--connection-requests "$component"',
      ],
    ],
    [
      'infra/scripts/vps-pull-build-up.sh',
      ['maxim_eraser_install_connection_request_floor "$TARGET_SHA"'],
    ],
    [
      'infra/scripts/vps-release-rollback.sh',
      [
        'maxim_topology_require_eraser_connection_requests "${COMPONENT_SOURCE_SHA[eraser]}" eraser',
      ],
    ],
    [
      'infra/scripts/vps-runtime-rollback.sh',
      ['maxim_topology_require_eraser_connection_requests "$TARGET_FULL_SHA" all'],
    ],
    [
      'infra/scripts/vps-connect.sh',
      [
        'eraser-connection-request-version',
        'maxim_topology_require_eraser_connection_requests "$(git rev-parse HEAD)" tooling',
      ],
    ],
    [
      'infra/scripts/lib/eraser-deploy.sh',
      ['maxim_eraser_install_connection_request_floor()', '--install-connection-request-floor'],
    ],
    [
      'infra/scripts/assert-eraser-source.mjs',
      ['assertEraserConnectionRequestSource', '--connection-requests'],
    ],
  ],
});

// FLAG: This floor is permanent even after expiry, cancellation, or disabling Lastik.
export function validateEraserConnectionRequestFloor(path = ERASER_CONNECTION_REQUEST_FLOOR) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== 2 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid() ||
      readFileSync(descriptor, 'utf8') !== '1\n'
    )
      throw new Error('Installed Lastik connection request reader floor is unknown or unsafe.');
  } finally {
    closeSync(descriptor);
  }
}

export function installEraserConnectionRequestFloor(path = ERASER_CONNECTION_REQUEST_FLOOR) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, '1\n');
    fsyncSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  validateEraserConnectionRequestFloor(path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function assertEraserConnectionRequestSource(
  sha,
  component = 'all',
  readSource = (path) =>
    execFileSync('git', ['show', `${sha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? ''))
    throw new Error('Lastik connection request reader requires an exact source SHA.');
  const scopes = component === 'all' ? Object.keys(ERASER_CONNECTION_REQUEST_CHECKS) : [component];
  if (scopes.some((scope) => !Object.hasOwn(ERASER_CONNECTION_REQUEST_CHECKS, scope)))
    throw new Error('Unknown Lastik connection request source component.');
  for (const scope of scopes) {
    for (const [path, markers] of ERASER_CONNECTION_REQUEST_CHECKS[scope]) {
      const raw = readSource(path);
      const source =
        typeof raw === 'string'
          ? raw.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*(?:\/\/|#).*$/gmu, '')
          : '';
      if (markers.some((marker) => !source.includes(marker)))
        throw new Error(
          `Rollback target lacks the installed Lastik connection request reader: ${path}`,
        );
    }
  }
}

// FLAG: A disabled availability flag cannot revoke persisted Lastik ownership.
export const ERASER_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    ['ERASER_OWNERSHIP_VERSION = 1', 'eraser_chat_bindings'],
  ],
  [
    'apps/api/src/message-retention/message-retention-binding.ts',
    ['eraser_chat_bindings', '"eraserOwned"'],
  ],
  [
    'apps/api/src/message-retention/message-retention-delete-guard.service.ts',
    ['binding?.eraserOwned'],
  ],
]);

export function assertEraserSource(
  sha,
  readSource = (path) =>
    execFileSync('git', ['show', `${sha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? ''))
    throw new Error('Lastik rollback requires an exact source SHA.');
  for (const [path, markers] of ERASER_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker))) {
      throw new Error(`Rollback target lacks the installed Lastik ownership reader: ${path}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [sha, action, component] = process.argv.slice(2);
    if (action === '--connection-requests') {
      assertEraserConnectionRequestSource(sha, component);
    } else if (action === '--install-connection-request-floor') {
      assertEraserConnectionRequestSource(sha);
      installEraserConnectionRequestFloor();
    } else if (action === '--validate-connection-request-floor') {
      validateEraserConnectionRequestFloor();
    } else if (action === undefined) assertEraserSource(sha);
    else throw new Error('Unknown Lastik source guard operation.');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
