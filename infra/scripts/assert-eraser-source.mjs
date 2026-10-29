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
export const ERASER_RATE_LIMIT_READER_FLOOR =
  '/var/lib/maxim-deploy/eraser-rate-limit-reader-version';
export const LEGACY_RETENTION_RETIREMENT_FLOOR =
  '/var/lib/maxim-deploy/legacy-message-retention-retirement-version';

export const ERASER_RATE_LIMIT_READER_CHECKS = Object.freeze({
  eraser: [
    [
      'apps/eraser/src/rate-limit.ts',
      [
        'ERASER_RATE_LIMIT_READER_VERSION = 1;',
        'class DurableRateLimit',
        'async remainingMs(',
        'async extend(',
        'this.pool.query',
      ],
    ],
    ['apps/eraser/src/limiter.ts', ['remainingMs(', 'extend(']],
    ['apps/eraser/src/main.ts', ['new DurableRateLimit(pool, settings.botId)']],
    ['apps/eraser/src/register-webhook.ts', ['new DurableRateLimit(pool, settings.botId)']],
    [
      'apps/eraser/migrations/0005-durable-rate-limit.sql',
      ['CREATE TABLE eraser_rate_limits (', 'not_before timestamptz NOT NULL'],
    ],
  ],
  tooling: [
    [
      'infra/scripts/lib/deploy-topology.sh',
      [
        'maxim_topology_require_eraser_rate_limit_reader()',
        'eraser-rate-limit-reader-version',
        '--validate-rate-limit-reader-floor',
        '--rate-limit-reader "$component"',
      ],
    ],
    [
      'infra/scripts/vps-pull-build-up.sh',
      [
        'maxim_eraser_install_rate_limit_reader_floor "$TARGET_SHA"',
        'maxim_topology_require_eraser_rate_limit_reader "$(git rev-parse "origin/$BRANCH")" tooling',
        'maxim_topology_require_eraser_rate_limit_reader "$(git rev-parse "refs/heads/$BRANCH")" tooling',
      ],
    ],
    [
      'infra/scripts/vps-release-rollback.sh',
      ['maxim_topology_require_eraser_rate_limit_reader "${COMPONENT_SOURCE_SHA[eraser]}" eraser'],
    ],
    [
      'infra/scripts/vps-runtime-rollback.sh',
      ['maxim_topology_require_eraser_rate_limit_reader "$TARGET_FULL_SHA" tooling'],
    ],
    [
      'infra/scripts/vps-connect.sh',
      [
        'eraser-rate-limit-reader-version',
        'maxim_topology_require_eraser_rate_limit_reader "$(git rev-parse HEAD)" tooling',
        'maxim_topology_require_eraser_rate_limit_reader "$expected_tooling_sha" tooling',
      ],
    ],
    [
      'infra/scripts/lib/eraser-deploy.sh',
      ['maxim_eraser_install_rate_limit_reader_floor()', '--install-rate-limit-reader-floor'],
    ],
    [
      'infra/scripts/assert-eraser-source.mjs',
      [
        'export function assertEraserRateLimitReaderSource(',
        'assertEraserRateLimitReaderSource(sha, component)',
        'validateEraserRateLimitReaderFloor();',
        'installEraserRateLimitReaderFloor();',
      ],
    ],
  ],
});

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
  validateReaderFloor(path, 'connection request');
}

function validateReaderFloor(path, name) {
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
      throw new Error(`Installed Lastik ${name} reader floor is unknown or unsafe.`);
  } finally {
    closeSync(descriptor);
  }
}

export function installEraserConnectionRequestFloor(path = ERASER_CONNECTION_REQUEST_FLOOR) {
  installReaderFloor(path, 'connection request');
}

function installReaderFloor(path, name) {
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
  validateReaderFloor(path, name);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

// FLAG: Persisted token cooldowns survive restarts, expiry and disabled execution.
export function validateEraserRateLimitReaderFloor(path = ERASER_RATE_LIMIT_READER_FLOOR) {
  validateReaderFloor(path, 'rate limit');
}

export function installEraserRateLimitReaderFloor(path = ERASER_RATE_LIMIT_READER_FLOOR) {
  installReaderFloor(path, 'rate limit');
}

// FLAG: Retirement is permanent; flags and old journals cannot restore Major's age executor.
export function validateLegacyRetentionRetirementFloor(path = LEGACY_RETENTION_RETIREMENT_FLOOR) {
  validateReaderFloor(path, 'legacy retention retirement');
}

export function installLegacyRetentionRetirementFloor(path = LEGACY_RETENTION_RETIREMENT_FLOOR) {
  installReaderFloor(path, 'legacy retention retirement');
}

// FLAG: A quoted or commented capability is not a reader. Keep quoted shell arguments intact,
// but require each marker to start in executable source rather than a literal or comment.
function activeReaderSource(raw, path) {
  const source = typeof raw === 'string' ? raw : '';
  const visible = source.split('');
  const active = new Uint8Array(source.length);
  const shell = path.endsWith('.sh');
  const sql = path.endsWith('.sql');
  let index = 0;
  let expressionStart = true;
  const hideComment = (start, end) => {
    for (let cursor = start; cursor < end; cursor++)
      if (source[cursor] !== '\n') visible[cursor] = ' ';
    index = end;
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (shell && char === '\\') {
      active[index] = 1;
      index += 2;
      continue;
    }
    if (
      (shell && char === '#' && (index === 0 || /[\s;|&()]/u.test(source[index - 1]))) ||
      (sql && char === '-' && next === '-') ||
      (!shell && !sql && char === '/' && next === '/')
    ) {
      const end = source.indexOf('\n', index);
      hideComment(index, end < 0 ? source.length : end);
      continue;
    }
    if (!shell && char === '/' && next === '*') {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < source.length && depth) {
        if (sql && source.slice(index, index + 2) === '/*') {
          depth++;
          index += 2;
        } else if (source.slice(index, index + 2) === '*/') {
          depth--;
          index += 2;
        } else index++;
      }
      hideComment(start, index);
      continue;
    }
    const dollarQuote = sql
      ? /^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/u.exec(source.slice(index))?.[0]
      : null;
    if (dollarQuote) {
      const end = source.indexOf(dollarQuote, index + dollarQuote.length);
      index = end < 0 ? source.length : end + dollarQuote.length;
      continue;
    }
    if (char === "'" || char === '"' || (!sql && char === '`')) {
      const quote = char;
      index++;
      while (index < source.length) {
        if (source[index] === '\\' && (!shell || quote !== "'")) index += 2;
        else if (source[index] === quote) {
          index++;
          if (sql && source[index] === quote) index++;
          else break;
        } else index++;
      }
      expressionStart = false;
      continue;
    }
    if (!shell && !sql && char === '/' && expressionStart) {
      index++;
      let characterClass = false;
      while (index < source.length && source[index] !== '\n') {
        const value = source[index++];
        if (value === '\\') index++;
        else if (value === '[') characterClass = true;
        else if (value === ']') characterClass = false;
        else if (value === '/' && !characterClass) break;
      }
      expressionStart = false;
      continue;
    }
    if (!shell && !sql && /[a-zA-Z_$]/u.test(char)) {
      const start = index++;
      while (index < source.length && /[a-zA-Z_0-9$]/u.test(source[index])) index++;
      active.fill(1, start, index);
      expressionStart =
        /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|new)$/u.test(
          source.slice(start, index),
        );
      continue;
    }
    active[index++] = 1;
    if (!/\s/u.test(char)) expressionStart = '([{,:;=!?&|+-*%^~<>'.includes(char);
  }
  return { source: visible.join(''), active };
}

export const LEGACY_RETENTION_RETIREMENT_CHECKS = Object.freeze({
  'api-shared': [
    [
      'apps/api/src/message-retention/message-retention-store.service.ts',
      ['export const LEGACY_RETENTION_EXECUTION_RETIRED = true;', 'return false;'],
    ],
    [
      'apps/api/src/message-retention/message-retention-delete-guard.service.ts',
      ['async assertAllowed(', 'throw new MessageRetentionGuardError('],
    ],
    [
      'apps/api/src/message-retention/message-retention-binding.ts',
      ['export function retentionBindingQuery('],
    ],
    [
      'apps/api/src/moderation/moderation-delete-intent.service.ts',
      ['async reconcileRetentionIntent('],
    ],
    [
      'apps/api/src/message-retention/message-retention-runtime.service.ts',
      ['async process(', 'reconcileRetentionIntent(', 'retireTransferredCandidates('],
    ],
  ],
  tooling: [
    [
      'infra/scripts/lib/deploy-topology.sh',
      [
        'maxim_topology_require_retired_message_retention()',
        '--validate-retention-retirement-floor',
        '--retention-retirement "$component"',
      ],
    ],
    [
      'infra/scripts/vps-pull-build-up.sh',
      [
        'maxim_eraser_install_retired_message_retention_floor "$TARGET_SHA"',
        'maxim_topology_require_retired_message_retention "$(git rev-parse "origin/$BRANCH")" tooling',
        'maxim_topology_require_retired_message_retention "$(git rev-parse "refs/heads/$BRANCH")" tooling',
      ],
    ],
    [
      'infra/scripts/vps-release-rollback.sh',
      ['maxim_topology_require_retired_message_retention "$API_SOURCE_SHA" api-shared'],
    ],
    [
      'infra/scripts/vps-runtime-rollback.sh',
      ['maxim_topology_require_retired_message_retention "$TARGET_FULL_SHA" all'],
    ],
    [
      'infra/scripts/vps-connect.sh',
      [
        'legacy-message-retention-retirement-version',
        'maxim_topology_require_retired_message_retention "$(git rev-parse HEAD)" tooling',
        'maxim_topology_require_retired_message_retention "$expected_tooling_sha" tooling',
      ],
    ],
    [
      'infra/scripts/lib/eraser-deploy.sh',
      [
        'maxim_eraser_install_retired_message_retention_floor()',
        '--install-retention-retirement-floor',
      ],
    ],
    [
      'infra/scripts/assert-eraser-source.mjs',
      [
        'export function assertLegacyRetentionRetirementSource(',
        'validateLegacyRetentionRetirementFloor();',
        'installLegacyRetentionRetirementFloor();',
      ],
    ],
  ],
});

export function assertLegacyRetentionRetirementSource(
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
    throw new Error('Legacy retention retirement requires an exact source SHA.');
  const scopes =
    component === 'all' ? Object.keys(LEGACY_RETENTION_RETIREMENT_CHECKS) : [component];
  if (scopes.some((scope) => !Object.hasOwn(LEGACY_RETENTION_RETIREMENT_CHECKS, scope)))
    throw new Error('Unknown legacy retention retirement component.');
  const sources = new Map();
  for (const scope of scopes) {
    for (const [path, markers] of LEGACY_RETENTION_RETIREMENT_CHECKS[scope]) {
      const { source, active } = activeReaderSource(readSource(path), path);
      sources.set(path, source);
      if (
        markers.some((marker) => {
          for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1))
            if (active[at]) return false;
          return true;
        })
      )
        throw new Error(`Rollback target lacks permanent legacy retention retirement: ${path}`);
    }
  }
  if (!scopes.includes('api-shared')) return;
  const store = sources.get('apps/api/src/message-retention/message-retention-store.service.ts');
  const guard = sources.get(
    'apps/api/src/message-retention/message-retention-delete-guard.service.ts',
  );
  const bindingReader = sources.get('apps/api/src/message-retention/message-retention-binding.ts');
  const executor = sources.get('apps/api/src/moderation/moderation-delete-intent.service.ts');
  const runtime = sources.get(
    'apps/api/src/message-retention/message-retention-runtime.service.ts',
  );
  const forbidden =
    /\b(?:ensureRetentionIntent|attemptRetentionIntent|captureRetentionMessage|readRetentionCapture)\s*\(/u;
  const dispatch = /if\s*\(intent\.retentionOwned\)\s*(?:\{\s*)?return false;/u;
  const allows = /\ballows\([^)]*\)\s*:\s*boolean\s*\{\s*return false;\s*\}/u;
  const rejectOnly =
    /async assertAllowed\([\s\S]*?\)\s*:\s*Promise<void>\s*\{\s*throw new MessageRetentionGuardError\(/u;
  const remoteOrWriteGuard =
    /\b(?:MaxClientService|MaxBotLinkService|BackgroundRuntimeGovernorService|MessageRetentionAdmissionService|INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b|\bfetch\s*\(|\.(?:max|maxClient)\.|\.(?:create|update|delete|upsert)\w*\s*\(|\$executeRaw/u;
  const reconcileStart = executor.indexOf('async reconcileRetentionIntent(');
  const reconcileOpen = executor.indexOf('{', reconcileStart);
  const { active: executorActive } = activeReaderSource(executor, 'executor.ts');
  let reconcileEnd = reconcileOpen + 1;
  let depth = 1;
  for (; reconcileEnd < executor.length && depth > 0; reconcileEnd++) {
    if (!executorActive[reconcileEnd]) continue;
    if (executor[reconcileEnd] === '{') depth++;
    if (executor[reconcileEnd] === '}') depth--;
  }
  const reconcile = executor.slice(reconcileOpen, reconcileEnd);
  if (
    depth !== 0 ||
    !executor.includes('intent."retention_owned" = FALSE') ||
    !allows.test(store) ||
    !rejectOnly.test(guard) ||
    remoteOrWriteGuard.test([guard, bindingReader].join('\n')) ||
    !bindingReader.includes('WHERE intent."id" = ${intentId}') ||
    !bindingReader.includes('LIMIT 1') ||
    !guard.includes("'runtime_retired'") ||
    !dispatch.test(executor) ||
    forbidden.test([store, guard, executor, runtime].join('\n')) ||
    /\b(?:verifyMessageAbsence|resolveDeleteRouteWithRefresh|\.max\.|\.maxClient\.)/u.test(
      reconcile,
    ) ||
    /\b(?:MaxClientService|MessageRetentionAdmissionService|remoteDecision|allowRead|canRead)\b/u.test(
      runtime,
    )
  )
    throw new Error(
      'Rollback target lacks permanent legacy retention retirement: executable boundary',
    );
}

export function assertEraserRateLimitReaderSource(
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
    throw new Error('Lastik rate limit reader requires an exact source SHA.');
  const scopes = component === 'all' ? Object.keys(ERASER_RATE_LIMIT_READER_CHECKS) : [component];
  if (scopes.some((scope) => !Object.hasOwn(ERASER_RATE_LIMIT_READER_CHECKS, scope)))
    throw new Error('Unknown Lastik rate limit source component.');
  for (const scope of scopes) {
    for (const [path, markers] of ERASER_RATE_LIMIT_READER_CHECKS[scope]) {
      const { source, active } = activeReaderSource(readSource(path), path);
      const hasActiveMarker = (marker) => {
        for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1))
          if (active[at]) return true;
        return false;
      };
      if (markers.some((marker) => !hasActiveMarker(marker)))
        throw new Error(`Rollback target lacks the installed Lastik rate limit reader: ${path}`);
    }
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
      if (path.endsWith('message-retention-delete-guard.service.ts')) {
        try {
          assertLegacyRetentionRetirementSource(sha, 'api-shared', readSource);
          continue;
        } catch {
          /* A partial retirement is not a persisted ownership fence. */
        }
      }
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
    } else if (action === '--retention-retirement') {
      assertLegacyRetentionRetirementSource(sha, component);
    } else if (action === '--install-retention-retirement-floor') {
      assertLegacyRetentionRetirementSource(sha);
      installLegacyRetentionRetirementFloor();
    } else if (action === '--validate-retention-retirement-floor') {
      validateLegacyRetentionRetirementFloor();
    } else if (action === '--rate-limit-reader') {
      assertEraserRateLimitReaderSource(sha, component);
    } else if (action === '--install-rate-limit-reader-floor') {
      assertEraserRateLimitReaderSource(sha);
      installEraserRateLimitReaderFloor();
    } else if (action === '--validate-rate-limit-reader-floor') {
      validateEraserRateLimitReaderFloor();
    } else if (action === undefined) assertEraserSource(sha);
    else throw new Error('Unknown Lastik source guard operation.');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
