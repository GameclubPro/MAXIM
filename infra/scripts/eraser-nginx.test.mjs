import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ERASER_LOCATIONS, ERASER_UPSTREAM, renderEraserNginx } from './eraser-nginx.mjs';
import { buildReleaseManifest } from './release-manifest.mjs';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

const SHA = 'a'.repeat(40);
const COMPONENT_SHA = 'c'.repeat(40);
const hostSite = `# Host-managed configuration: keep exact whitespace and comments.
upstream major_maxim_api_webhook_ingress {
  server 127.0.0.1:3001;
  keepalive 32;
}

server {
  include /etc/nginx/snippets/project-migration-server.conf;
  listen 80;
  listen [::]:80;
  server_name major-maksimov.ru www.major-maksimov.ru app.major-maksimov.ru;
  location / { return 301 https://major-maksimov.ru$request_uri; }
}

server {
  include /etc/nginx/snippets/project-migration-server.conf;
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name www.major-maksimov.ru app.major-maksimov.ru;
  location / { return 301 https://major-maksimov.ru$request_uri; }
}

server {
  include /etc/nginx/snippets/project-migration-server.conf;
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name major-maksimov.ru;
  client_max_body_size 32m;
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Host-Literal "{ server_name major-maksimov.ru; } # quoted" always;

  location = /robots.txt {
    default_type text/plain;
    add_header Cache-Control "public, max-age=3600" always;
    return 200 "User-agent: *\\nDisallow: /api/\\n";
  }

  location ^~ /api/webhook/ {
    client_max_body_size 8m;
    client_body_timeout 11s;
    proxy_request_buffering on;
    proxy_pass http://major_maxim_api_webhook_ingress;
  }

  # Sibling-owned include and route must remain byte-for-byte intact.
  include /etc/nginx/snippets/karavan-sse-locations.conf;
  location ^~ /karavan/api/ {
    rewrite ^/karavan(/api/.*)$ $1 break;
    proxy_pass http://major_karavan_api_all;
  }
}
`;

test('Lastik renderer only inserts owned bytes and preserves host includes, headers and request limits', () => {
  const rendered = renderEraserNginx(hostSite);
  assert.equal(rendered.replace(ERASER_UPSTREAM, '').replace(ERASER_LOCATIONS, ''), hostSite);
  assert.equal(rendered.split(ERASER_UPSTREAM).length, 2);
  assert.equal(rendered.split(ERASER_LOCATIONS).length, 2);
  assert.equal(
    rendered.match(/include \/etc\/nginx\/snippets\/project-migration-server\.conf;/gu)?.length,
    3,
  );
  assert.match(
    rendered,
    /client_max_body_size 8m;\n {4}client_body_timeout 11s;\n {4}proxy_request_buffering on;/u,
  );
  assert.match(rendered, /location = \/eraser\/webhook\s*\{/u);
  assert.match(rendered, /location = \/eraser\s*\{/u);
  assert.match(rendered, /location \^~ \/eraser\/\s*\{/u);
  assert.equal(renderEraserNginx(rendered), rendered, 'exact owned insertions are idempotent');
});

test('Lastik renderer rejects partial, modified and duplicated owned authority', () => {
  const rendered = renderEraserNginx(hostSite);
  for (const [name, input] of [
    ['upstream only', ERASER_UPSTREAM + hostSite],
    [
      'locations only',
      hostSite.replace('  location = /robots.txt', ERASER_LOCATIONS + '  location = /robots.txt'),
    ],
    ['duplicate upstream', ERASER_UPSTREAM + rendered],
    ['duplicate locations', rendered + ERASER_LOCATIONS],
    ['modified upstream', rendered.replace('127.0.0.1:3005', '127.0.0.1:3999')],
    [
      'modified locations',
      rendered.replace('client_max_body_size 2m;', 'client_max_body_size 3m;'),
    ],
    [
      'conflicting route',
      hostSite.replace(
        '  location = /robots.txt',
        '  location /eraser/ { return 200; }\n  location = /robots.txt',
      ),
    ],
    [
      'unmarked upstream reference',
      `upstream major_eraser_webhook { server 127.0.0.1:3005; }\n${hostSite}`,
    ],
    [
      'foreign upstream use',
      hostSite.replace(
        '  location = /robots.txt',
        '  location /another/ { proxy_pass http://major_eraser_webhook; }\n  location = /robots.txt',
      ),
    ],
  ])
    assert.throws(() => renderEraserNginx(input), undefined, name);
});

test('Lastik renderer fails closed on unknown or ambiguous anchors and malformed syntax', () => {
  for (const [name, input] of [
    [
      'missing upstream',
      hostSite.replace('major_maxim_api_webhook_ingress', 'other_webhook_ingress'),
    ],
    ['missing robots anchor', hostSite.replace('location = /robots.txt', 'location = /other.txt')],
    [
      'missing canonical host',
      hostSite.replace('server_name major-maksimov.ru;', 'server_name another.test;'),
    ],
    [
      'extra canonical host',
      hostSite.replace(
        'server_name major-maksimov.ru;',
        'server_name major-maksimov.ru another.test;',
      ),
    ],
    ['missing ssl', hostSite.replaceAll('443 ssl;', '443;')],
    [
      'duplicate canonical server',
      `${hostSite}\nserver { listen 443 ssl; server_name major-maksimov.ru; location = /robots.txt { return 200; } }\n`,
    ],
    ['unterminated string', hostSite + 'add_header X-Broken "unfinished;\n'],
    ['unbalanced block', hostSite + '}\n'],
    [
      'nested server is not an anchor',
      hostSite.replace('server_name major-maksimov.ru;', 'server_name another.test;') +
        '\nmap $x $y { server { listen 443 ssl; server_name major-maksimov.ru; location = /robots.txt { return 200; } } }\n',
    ],
  ])
    assert.throws(() => renderEraserNginx(input), undefined, name);
});

function fixture(t, mode = 'success') {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-eraser-nginx-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const scripts = join(repo, 'infra/scripts');
  const lock = deployLockFixture(directory, join(scripts, 'lib/deploy-lock.sh'));
  writeFileSync(lock.file, '', { mode: 0o600 });
  const manifest = buildReleaseManifest({
    releaseId: 'fixture-current',
    targetSha: SHA,
    createdAt: '2026-10-26T00:00:00.000Z',
    components: ['api-shared', 'miniapp-major-static', 'admin-static', 'eraser']
      .filter((id) => mode !== 'missing-component' || id !== 'eraser')
      .map((id) => {
        const sourceSha = id === 'eraser' ? COMPONENT_SHA : SHA;
        return {
          id,
          sourceSha,
          imageRef: `maxim-${id}:${sourceSha}`,
          imageId: `sha256:${'d'.repeat(64)}`,
        };
      }),
  });
  if (mode !== 'missing-manifest')
    writeFileSync(join(lock.protectedDirectory, 'current.json'), JSON.stringify(manifest));
  writeFileSync(
    join(scripts, 'lib/legacy-cold-maintenance.sh'),
    'maxim_require_ordinary_effect_authority() { require_deploy_lock || return; [[ "$FIXTURE_MODE" != authority-denied ]]; }\n',
  );
  const paths = {
    config: join(directory, 'sites-available/major-maksimov.ru.conf'),
    enabled: join(directory, 'sites-enabled/major-maksimov.ru.conf'),
    backups: join(directory, 'backups'),
    foreign: join(directory, 'sites-available/foreign.conf'),
  };
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  mkdirSync(dirname(paths.config), { recursive: true });
  mkdirSync(dirname(paths.enabled), { recursive: true });
  writeFileSync(paths.config, mode === 'already-patched' ? renderEraserNginx(hostSite) : hostSite, {
    mode: 0o644,
  });
  writeFileSync(paths.foreign, 'foreign site\n', { mode: 0o644 });
  symlinkSync(paths.config, paths.enabled);
  const sentinels = [
    'site/index.html',
    'snippets/project-migration-server.conf',
    'snippets/karavan-sse-locations.conf',
  ];
  for (const name of sentinels) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `keep ${name}\n`);
  }
  writeFileSync(
    join(scripts, 'eraser-nginx.mjs'),
    readFileSync(new URL('./eraser-nginx.mjs', import.meta.url)),
  );
  writeFileSync(
    join(scripts, 'release-manifest.mjs'),
    readFileSync(new URL('./release-manifest.mjs', import.meta.url)),
  );
  const source = readFileSync(new URL('./vps-eraser-nginx.sh', import.meta.url), 'utf8')
    .replace(/^ROOT_DIR=.*$/mu, 'ROOT_DIR="$FIXTURE_REPO"')
    .replace('DEPLOY_STATE=/var/lib/maxim-deploy', `DEPLOY_STATE="${lock.protectedDirectory}"`)
    .replaceAll('/etc/nginx/sites-available/major-maksimov.ru.conf', paths.config)
    .replaceAll('/etc/nginx/sites-enabled/major-maksimov.ru.conf', paths.enabled)
    .replaceAll('/etc/nginx/backups', paths.backups)
    .replace('/tmp/maxim-eraser-nginx.XXXXXXXX', join(directory, 'stage.XXXXXXXX'));
  const transaction = join(directory, 'transaction.sh');
  writeFileSync(transaction, source);
  const events = join(directory, 'events.log');
  const assertLocked = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if flock -n "$FIXTURE_LOCK_FILE" true; then echo "operation escaped protected lock" >&2; exit 97; fi',
    'printf "%s\\n" "$*" >> "$FIXTURE_EVENTS"',
  ];
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'case "$*" in',
      '  *"rev-parse HEAD"*) printf "%s\\n" "$FIXTURE_SHA" ;;',
      '  *"status --porcelain"*) if [[ "$FIXTURE_MODE" == dirty-source ]]; then printf "?? local-change\\n"; fi ;;',
      '  *) echo "unexpected git invocation" >&2; exit 98 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'sudo'),
    [
      ...assertLocked,
      'if [[ "${1:-}" == -n ]]; then shift; fi',
      'case "$1" in',
      '  nginx|systemctl)',
      '    counter="$FIXTURE_DIRECTORY/$1.count"',
      '    count=0; if [[ -f "$counter" ]]; then count="$(cat "$counter")"; fi',
      '    count=$((count+1)); printf "%s\\n" "$count" >"$counter"',
      '    if [[ ( "$count" == 2 && "$1" == nginx && "$FIXTURE_MODE" == nginx-fails ) || ( "$count" == 1 && "$1" == systemctl && "$FIXTURE_MODE" == reload-fails ) ]]; then exit 1; fi',
      '    exit 0 ;;',
      '  *) exec "$@" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'node'),
    [
      ...assertLocked,
      'if [[ "${2:-}" == swap && ! -e "$FIXTURE_DIRECTORY/verified" ]]; then',
      '  touch "$FIXTURE_DIRECTORY/verified"',
      '  if [[ "$FIXTURE_MODE" == content-drift ]]; then printf "third-party config\\n" >"$FIXTURE_CONFIG"; fi',
      '  if [[ "$FIXTURE_MODE" == link-drift ]]; then rm "$FIXTURE_ENABLED"; ln -s "$FIXTURE_FOREIGN" "$FIXTURE_ENABLED"; fi',
      'fi',
      'exec "$REAL_NODE" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'sleep'),
    [
      ...assertLocked,
      '[[ "$*" == 1 ]] || exit 98',
      'printf "sleep %s\\n" "$*" >> "$FIXTURE_EVENTS"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (spawnSync('flock', ['-n', process.env.FIXTURE_LOCK_FILE, 'true']).status === 0) process.exit(97);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_EVENTS, args.join(' ') + '\\n');
const url = args.find(arg => /^https?:/.test(arg));
let status = 404, body = '{"code":"NOT_FOUND"}', curlExit = 0;
const mode = process.env.FIXTURE_MODE;
const webhook = url?.endsWith('/eraser/webhook');
const post = webhook && args.includes('POST');
const counter = process.env.FIXTURE_DIRECTORY + '/post.count';
let attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
if (post) fs.writeFileSync(counter, String(++attempt));
if (url === 'http://127.0.0.1:3005/health') { status = 200; body = JSON.stringify({ status: 'ok', service: 'eraser', enabled: true, schedulerHealthy: true, commitSha: process.env.FIXTURE_HEALTH_SHA }); }
if (webhook) {
  status = ['smoke-fails','foreign-after-install'].includes(mode) ? 500 : 403;
  if (post && mode === 'old-workers' && attempt < 5) status = 404;
  if (!post && mode === 'method-delayed' && attempt === 1) status = 404;
  if (!post && mode === 'method-leak') status = 200;
  body = status === 403 ? '{"code":"FORBIDDEN"}' : '{"code":"FAILED"}';
  if (post && mode === 'malformed-body') body = '{';
  if (post && mode === 'wrong-forbidden-code') body = '{"code":"OTHER"}';
  if (post && mode === 'transport-fails') curlExit = 7;
  if (mode === 'foreign-after-install' || (!post && mode === 'foreign-after-success')) fs.writeFileSync(process.env.FIXTURE_CONFIG, 'third-party config\\n');
}
if (url?.endsWith('/eraser/internal/v1/runtime') && mode === 'internal-leak') status = 200;
function option(short, long) { const index = args.findIndex(arg => arg === short || arg === long); return index < 0 ? null : args[index + 1]; }
const output = option('-o', '--output');
if (output && output !== '/dev/null') fs.writeFileSync(output, body);
else if (!output) process.stdout.write(body);
const headers = option('-D', '--dump-header');
const head = 'HTTP/1.1 ' + status + ' Status\\r\\nStrict-Transport-Security: max-age=31536000\\r\\nX-Content-Type-Options: nosniff\\r\\nReferrer-Policy: strict-origin-when-cross-origin\\r\\n\\r\\n';
if (headers === '-') process.stdout.write(head);
else if (headers) fs.writeFileSync(headers, head);
const format = option('-w', '--write-out');
if (format) process.stdout.write(format.replaceAll('%{http_code}', String(status)).replaceAll('\\\\n', '\\n'));
if (curlExit) process.exit(curlExit);
if (status >= 400 && args.some(arg => arg === '--fail' || arg === '-f' || /^-[^-]*f/.test(arg))) process.exit(22);
`,
    { mode: 0o755 },
  );
  const env = deployLockEnvironment({
    PATH: `${bin}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
    FIXTURE_REPO: repo,
    FIXTURE_DIRECTORY: directory,
    FIXTURE_EVENTS: events,
    FIXTURE_LOCK_FILE: lock.file,
    FIXTURE_MODE: mode,
    FIXTURE_SHA: mode === 'wrong-source' ? 'b'.repeat(40) : SHA,
    FIXTURE_HEALTH_SHA: mode === 'wrong-health-sha' ? 'b'.repeat(40) : COMPONENT_SHA,
    FIXTURE_CONFIG: paths.config,
    FIXTURE_ENABLED: paths.enabled,
    FIXTURE_FOREIGN: paths.foreign,
  });
  const run = (apply = true, busy = false) =>
    spawnSync(
      busy ? 'flock' : 'bash',
      busy
        ? ['-n', lock.file, 'bash', transaction, SHA, ...(apply ? ['--apply'] : [])]
        : [transaction, SHA, ...(apply ? ['--apply'] : [])],
      { env, encoding: 'utf8', timeout: 15000 },
    );
  const assertUntouchedSiblings = () => {
    for (const name of sentinels)
      assert.equal(readFileSync(join(directory, name), 'utf8'), `keep ${name}\n`);
  };
  const assertReleased = () => {
    const result = spawnSync(
      'bash',
      ['-c', 'source "$1"; acquire_deploy_lock; release_deploy_lock', 'probe', lock.helper],
      { env, encoding: 'utf8', timeout: 3000 },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  return { paths, events, directory, lock, manifest, run, assertUntouchedSiblings, assertReleased };
}

test('Lastik nginx preview preserves the live config and enabled symlink without mutation or POST smoke', (t) => {
  const h = fixture(t);
  const inode = lstatSync(h.paths.enabled).ino;
  const result = h.run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(h.paths.config, 'utf8'), hostSite);
  assert.equal(lstatSync(h.paths.enabled).ino, inode);
  assert.equal(readlinkSync(h.paths.enabled), h.paths.config);
  assert.equal(existsSync(h.paths.backups), false);
  const events = existsSync(h.events) ? readFileSync(h.events, 'utf8') : '';
  assert.doesNotMatch(events, /(?:systemctl|nginx -t|POST|\binstall\b|\bmv\b|\bcp\b)/u);
  h.assertUntouchedSiblings();
  h.assertReleased();
});

test('Lastik nginx refuses a busy protected lock before touching the active site', (t) => {
  const h = fixture(t);
  const inode = statSync(h.lock.file).ino;
  const result = h.run(true, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /holds the deploy lock/u);
  assert.equal(existsSync(h.events), false);
  assert.equal(readFileSync(h.paths.config, 'utf8'), hostSite);
  assert.equal(statSync(h.lock.file).ino, inode);
  h.assertReleased();
});

for (const mode of [
  'wrong-source',
  'dirty-source',
  'authority-denied',
  'wrong-health-sha',
  'missing-manifest',
  'missing-component',
]) {
  test(`Lastik nginx refuses ${mode} before any active site mutation`, (t) => {
    const h = fixture(t, mode);
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(h.paths.config, 'utf8'), hostSite);
    assert.equal(readlinkSync(h.paths.enabled), h.paths.config);
    assert.equal(existsSync(h.paths.backups), false);
    const events = existsSync(h.events) ? readFileSync(h.events, 'utf8') : '';
    assert.doesNotMatch(events, /(?:systemctl|nginx -t|POST|\binstall\b|\bmv\b|\bcp\b)/u);
    h.assertUntouchedSiblings();
    h.assertReleased();
  });
}

test('Lastik nginx applies only its own additions with lock held through exact namespace smokes', (t) => {
  const h = fixture(t);
  const inode = lstatSync(h.paths.enabled).ino;
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(h.paths.config, 'utf8'), renderEraserNginx(hostSite));
  assert.equal(lstatSync(h.paths.enabled).ino, inode);
  assert.equal(readlinkSync(h.paths.enabled), h.paths.config);
  const events = readFileSync(h.events, 'utf8');
  assert.match(events, /systemctl reload nginx/u);
  assert.match(events, /\/eraser\/webhook/u);
  assert.match(events, /\/eraser\/internal\/v1\//u);
  assert.equal(smokeObservations(h).stages.length, 0, 'first-pass success removes private staging');
  assert.ok(readdirSync(h.paths.backups).length > 0, 'prior config has a retained external backup');
  h.assertUntouchedSiblings();
  h.assertReleased();
});

test('Lastik nginx accepts the exact inherited component SHA from the active immutable release', (t) => {
  const h = fixture(t);
  assert.notEqual(
    h.manifest.components.eraser.sourceSha,
    SHA,
    'tooling and component sources differ',
  );
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(h.paths.config, 'utf8'), renderEraserNginx(hostSite));
  const events = readFileSync(h.events, 'utf8');
  assert.match(events, /release-manifest\.mjs validate-current --state-dir/u);
  h.assertUntouchedSiblings();
  h.assertReleased();
});

test('Lastik nginx verifies an already installed exact patch without backup, replacement or reload', (t) => {
  const h = fixture(t, 'already-patched');
  const configInode = statSync(h.paths.config).ino;
  const linkInode = lstatSync(h.paths.enabled).ino;
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(h.paths.config, 'utf8'), renderEraserNginx(hostSite));
  assert.equal(statSync(h.paths.config).ino, configInode);
  assert.equal(lstatSync(h.paths.enabled).ino, linkInode);
  assert.equal(existsSync(h.paths.backups), false);
  const events = readFileSync(h.events, 'utf8');
  assert.match(events, /\/eraser\/webhook/u);
  assert.doesNotMatch(events, /(?:systemctl|\bswap\b|\binstall\b)/u);
  h.assertUntouchedSiblings();
  h.assertReleased();
});

for (const mode of ['nginx-fails', 'reload-fails', 'smoke-fails']) {
  test(`Lastik nginx restores its previous bytes under lock after ${mode}`, (t) => {
    const h = fixture(t, mode);
    const inode = lstatSync(h.paths.enabled).ino;
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(h.paths.config, 'utf8'), hostSite, result.stderr);
    assert.equal(lstatSync(h.paths.enabled).ino, inode);
    assert.ok(readdirSync(h.paths.backups).length > 0);
    assert.match(readFileSync(h.events, 'utf8'), /systemctl reload nginx/u);
    h.assertUntouchedSiblings();
    h.assertReleased();
  });
}

for (const mode of ['content-drift', 'link-drift']) {
  test(`Lastik nginx refuses ${mode} at the live compare-and-swap boundary`, (t) => {
    const h = fixture(t, mode);
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.equal(
      readFileSync(h.paths.config, 'utf8'),
      mode === 'content-drift' ? 'third-party config\n' : hostSite,
    );
    assert.equal(
      readlinkSync(h.paths.enabled),
      mode === 'link-drift' ? h.paths.foreign : h.paths.config,
    );
    assert.doesNotMatch(readFileSync(h.events, 'utf8'), /systemctl reload nginx/u);
    h.assertUntouchedSiblings();
    h.assertReleased();
  });
}

test('Lastik nginx rollback preserves a foreign edit instead of overwriting it after a failed smoke', (t) => {
  const h = fixture(t, 'foreign-after-install');
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(h.paths.config, 'utf8'), 'third-party config\n');
  assert.ok(readdirSync(h.paths.backups).length > 0);
  assert.equal(readFileSync(h.events, 'utf8').match(/systemctl reload nginx/gu)?.length, 1);
  h.assertUntouchedSiblings();
  h.assertReleased();
});

function smokeObservations(h) {
  const events = readFileSync(h.events, 'utf8');
  const requests = events
    .split('\n')
    .filter(
      (line) => line.startsWith('--noproxy') && line.includes('https://major-maksimov.ru/eraser'),
    );
  const posts = requests.filter((line) => line.includes('-X POST'));
  const methods = requests.filter(
    (line) => line.endsWith('/eraser/webhook') && !line.includes('-X POST'),
  );
  const sleeps = events.split('\n').filter((line) => line === 'sleep 1');
  const stages = readdirSync(h.directory).filter((name) => name.startsWith('stage.'));
  return { events, requests, posts, methods, sleeps, stages };
}

test('Lastik nginx waits for old workers and accepts the fifth complete namespace smoke', (t) => {
  const h = fixture(t, 'old-workers');
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  const observed = smokeObservations(h);
  assert.equal(observed.posts.length, 5);
  assert.equal(observed.sleeps.length, 4);
  assert.equal(observed.methods.length, 1);
  assert.equal(observed.requests.length, 10, 'four stale POSTs plus one complete six-route smoke');
  assert.equal(observed.events.match(/systemctl reload nginx/gu)?.length, 1);
  assert.match(
    result.stderr,
    /attempt 4\/5 failed: path=\/eraser\/webhook assertion=status:403 status=404 curl_exit=0/u,
  );
  assert.equal(
    observed.stages.length,
    1,
    'transient failure evidence survives a successful commit',
  );
  const evidence = join(h.directory, observed.stages[0]);
  assert.equal(readFileSync(join(evidence, 'smoke-1-forbidden.json'), 'utf8'), '{"code":"FAILED"}');
  assert.equal(
    readFileSync(join(evidence, 'smoke-5-forbidden.json'), 'utf8'),
    '{"code":"FORBIDDEN"}',
  );
  assert.ok(observed.posts.every((line) => line.includes('--max-filesize 65536')));
  assert.equal(readFileSync(h.paths.config, 'utf8'), renderEraserNginx(hostSite));
  h.assertUntouchedSiblings();
  h.assertReleased();
});

test('Lastik nginx repeats the entire namespace when its last method check is not ready', (t) => {
  const h = fixture(t, 'method-delayed');
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  const observed = smokeObservations(h);
  assert.equal(observed.posts.length, 2);
  assert.equal(observed.methods.length, 2);
  assert.equal(observed.requests.length, 12);
  assert.equal(observed.sleeps.length, 1);
  assert.match(result.stderr, /assertion=status:403 status=404 curl_exit=0/u);
  h.assertUntouchedSiblings();
  h.assertReleased();
});

for (const [mode, failure, requestCount, methodCount] of [
  ['smoke-fails', /assertion=status:403 status=500 curl_exit=0/u, 5, 0],
  ['transport-fails', /assertion=transport status=403 curl_exit=7/u, 5, 0],
  ['malformed-body', /assertion=forbidden-body status=403 curl_exit=0/u, 5, 0],
  ['wrong-forbidden-code', /assertion=forbidden-body status=403 curl_exit=0/u, 5, 0],
  ['internal-leak', /path=\/eraser\/internal\/v1\/runtime assertion=status:404 status=200/u, 20, 0],
  ['method-leak', /path=\/eraser\/webhook assertion=status:403 status=200/u, 30, 5],
]) {
  test(`Lastik nginx exhausts exactly five strict ${mode} observations before owned rollback`, (t) => {
    const h = fixture(t, mode);
    const result = h.run();
    assert.notEqual(result.status, 0);
    const observed = smokeObservations(h);
    assert.equal(observed.posts.length, 5);
    assert.equal(observed.sleeps.length, 4);
    assert.equal(observed.requests.length, requestCount);
    assert.equal(observed.methods.length, methodCount);
    assert.equal(observed.events.match(/systemctl reload nginx/gu)?.length, 2);
    assert.match(result.stderr, failure);
    assert.match(result.stderr, /namespace readiness attempts exhausted/u);
    assert.match(result.stderr, /Previous nginx site bytes restored/u);
    assert.equal(observed.stages.length, 1, 'failed smoke evidence survives successful rollback');
    assert.ok(existsSync(join(h.directory, observed.stages[0], 'smoke-5-forbidden.json')));
    assert.equal(readFileSync(h.paths.config, 'utf8'), hostSite);
    h.assertUntouchedSiblings();
    h.assertReleased();
  });
}

test('Lastik nginx stops retrying a failed observation when its installed configuration drifts', (t) => {
  const h = fixture(t, 'foreign-after-install');
  const result = h.run();
  assert.notEqual(result.status, 0);
  const observed = smokeObservations(h);
  assert.equal(observed.posts.length, 1);
  assert.equal(observed.sleeps.length, 0);
  assert.equal(observed.events.match(/systemctl reload nginx/gu)?.length, 1);
  assert.equal(readFileSync(h.paths.config, 'utf8'), 'third-party config\n');
  assert.match(result.stderr, /rollback refused: live configuration or symlink changed/u);
  h.assertUntouchedSiblings();
  h.assertReleased();
});

test('Lastik nginx refuses a commit when the final successful request observes foreign configuration drift', (t) => {
  const h = fixture(t, 'foreign-after-success');
  const result = h.run();
  assert.notEqual(result.status, 0);
  const observed = smokeObservations(h);
  assert.equal(observed.posts.length, 1);
  assert.equal(observed.methods.length, 1);
  assert.equal(observed.requests.length, 6);
  assert.equal(observed.sleeps.length, 0);
  assert.equal(observed.events.match(/systemctl reload nginx/gu)?.length, 1);
  assert.equal(readFileSync(h.paths.config, 'utf8'), 'third-party config\n');
  assert.match(result.stderr, /rollback refused: live configuration or symlink changed/u);
  assert.doesNotMatch(result.stdout, /local authenticated-route isolation checks passed/u);
  h.assertUntouchedSiblings();
  h.assertReleased();
});
