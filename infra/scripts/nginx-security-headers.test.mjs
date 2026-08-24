import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const majorConfig = readFileSync(
  new URL('../nginx/major-maksimov.ru.conf', import.meta.url),
  'utf8',
);
const adminConfig = readFileSync(
  new URL('../nginx/admin.major-maksimov.ru.conf', import.meta.url),
  'utf8',
);
const legacyConfig = readFileSync(
  new URL('../nginx/maxim.play-team.ru.conf', import.meta.url),
  'utf8',
);
const karavanSseLocations = readFileSync(
  new URL('../nginx/snippets/karavan-sse-locations.conf', import.meta.url),
  'utf8',
);
const majorApplyScript = readFileSync(
  new URL('./vps-apply-major-site.sh', import.meta.url),
  'utf8',
);
const adminApplyScript = readFileSync(
  new URL('./vps-apply-major-admin-site.sh', import.meta.url),
  'utf8',
);
const legacyApplyScript = readFileSync(new URL('./vps-apply-nginx.sh', import.meta.url), 'utf8');

const MAJOR_SECURITY_HEADERS = [
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'Referrer-Policy',
];
const ADMIN_SECURITY_HEADERS = [
  ...MAJOR_SECURITY_HEADERS,
  'X-Robots-Tag',
  'Content-Security-Policy',
];

function readLocationBlocks(source) {
  const blocks = [];
  const locationPattern = /^[ \t]*location\s+[^\n{]+\{/gmu;

  for (const match of source.matchAll(locationPattern)) {
    const start = match.index;
    let depth = 0;
    let end = start;

    for (; end < source.length; end += 1) {
      if (source[end] === '{') {
        depth += 1;
      } else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }

    assert.equal(depth, 0, `Unclosed nginx location near offset ${start}`);
    blocks.push(source.slice(start, end));
  }

  return blocks;
}

function assertLocalHeadersPreserveSecuritySet(source, requiredHeaders) {
  const localHeaderLocations = readLocationBlocks(source).filter((block) =>
    /\badd_header\s+/u.test(block),
  );
  assert.ok(localHeaderLocations.length > 0, 'Expected nginx locations with local add_header');

  for (const block of localHeaderLocations) {
    const location = block.split('\n', 1)[0]?.trim() ?? 'unknown location';
    for (const header of requiredHeaders) {
      assert.match(
        block,
        new RegExp(`^[ \\t]*add_header\\s+${header}\\s+[^\\n]+\\balways\\s*;$`, 'mu'),
        `${location} must repeat ${header} because nginx does not inherit parent add_header directives`,
      );
    }
  }
}

test('major locations with local headers preserve the public security header set', () => {
  assertLocalHeadersPreserveSecuritySet(majorConfig, MAJOR_SECURITY_HEADERS);
});

test('MAX webhook streams request bodies into the bounded ingress route', () => {
  const webhookLocation = readLocationBlocks(majorConfig).find((block) =>
    /^\s*location\s+\^~\s+\/api\/webhook\/\s*\{/u.test(block),
  );

  assert.ok(webhookLocation, 'Expected the dedicated MAX webhook location');
  assert.match(webhookLocation, /^\s*client_max_body_size\s+4m\s*;\s*$/mu);
  assert.match(webhookLocation, /^\s*client_body_timeout\s+5s\s*;\s*$/mu);
  assert.match(webhookLocation, /^\s*proxy_request_buffering\s+off\s*;\s*$/mu);
  assert.match(webhookLocation, /^\s*proxy_http_version\s+1\.1\s*;\s*$/mu);
  assert.match(webhookLocation, /^\s*proxy_read_timeout\s+20s\s*;\s*$/mu);
});

test('Safety Desk locations with local headers preserve the complete closed-site header set', () => {
  assertLocalHeadersPreserveSecuritySet(adminConfig, ADMIN_SECURITY_HEADERS);
});

test('installed Karavan SSE locations preserve the public security header set', () => {
  assert.equal(readLocationBlocks(karavanSseLocations).length, 4);
  assertLocalHeadersPreserveSecuritySet(karavanSseLocations, MAJOR_SECURITY_HEADERS);
});

test('major site apply verifies inherited-header regressions after nginx reload', () => {
  for (const variable of [
    'major_robots_headers',
    'major_live_headers',
    'metrics_headers',
    'channels_headers',
    'channels_trailing_headers',
    'chats_trailing_headers',
  ]) {
    assert.ok(
      majorApplyScript.includes(`assert_major_security_headers "$${variable}"`),
      `major apply must verify security headers from ${variable}`,
    );
  }
});

test('Safety Desk apply verifies every public location with local headers after reload', () => {
  for (const variable of [
    'admin_root_headers',
    'admin_robots_headers',
    'admin_safety_headers',
    'admin_support_headers',
  ]) {
    assert.ok(
      adminApplyScript.includes(`assert_admin_security_headers "$${variable}"`),
      `Safety Desk apply must verify security headers from ${variable}`,
    );
  }
});

test('major site keeps rollback state through a direct local nginx header smoke', () => {
  assert.ok(majorApplyScript.includes("curl --noproxy '*'"));
  assert.ok(
    majorApplyScript.includes('--resolve major-maksimov.ru:443:127.0.0.1'),
    'major apply must bypass DNS, edge, and proxy configuration for its transactional smoke',
  );
  assert.ok(majorApplyScript.includes('if ! verify_local_nginx_with_retry; then'));
  assert.ok(majorApplyScript.includes('site_index_backup='));
  assert.ok(majorApplyScript.includes('/api/v1/system/metrics/queues'));
  assert.ok(majorApplyScript.includes('if ! restore_backup; then'));
  assert.ok(
    majorApplyScript.includes('Automatic nginx rollback failed; inspect the host before retrying.'),
  );
  assert.ok(
    majorApplyScript.indexOf('if ! verify_local_nginx_with_retry; then') <
      majorApplyScript.indexOf('cleanup_tmp\nREMOTE'),
    'major local smoke must run before the remote rollback context is released',
  );
});

test('major site retries the complete localhost smoke before rollback with safe diagnostics', () => {
  assert.ok(majorApplyScript.includes('LOCAL_SMOKE_MAX_ATTEMPTS=10'));
  assert.ok(majorApplyScript.includes('LOCAL_SMOKE_RETRY_DELAY_SECONDS=1'));
  assert.ok(majorApplyScript.includes('attempt <= LOCAL_SMOKE_MAX_ATTEMPTS'));
  assert.ok(majorApplyScript.includes('if verify_local_nginx; then'));
  assert.ok(majorApplyScript.includes('sleep "${LOCAL_SMOKE_RETRY_DELAY_SECONDS}"'));
  assert.ok(
    majorApplyScript.includes(
      'failed: path=${LOCAL_SMOKE_FAILURE_PATH:-unknown} assertion=${LOCAL_SMOKE_FAILURE_ASSERTION:-unknown}.',
    ),
    'failed localhost smokes must identify only the fixed path and assertion labels',
  );

  const retryCall = majorApplyScript.indexOf('if ! verify_local_nginx_with_retry; then');
  const rollbackAfterRetry = majorApplyScript.indexOf('if ! restore_backup; then', retryCall);
  assert.ok(retryCall >= 0);
  assert.ok(
    rollbackAfterRetry > retryCall,
    'rollback must start only after the bounded localhost smoke retry is exhausted',
  );
});

test('major site rolls back every incomplete post-mutation deployment path', () => {
  assert.ok(majorApplyScript.includes('trap finalize_remote_deploy EXIT'));
  assert.ok(majorApplyScript.includes('NGINX_MUTATED=1'));
  assert.ok(majorApplyScript.includes('DEPLOYMENT_COMMITTED=1'));
  assert.ok(majorApplyScript.includes('ROLLBACK_ATTEMPTED=1'));
  assert.ok(majorApplyScript.includes('ROLLBACK_SUCCEEDED=1'));
  assert.ok(
    majorApplyScript.includes(
      'Rollback backups retained under ${REMOTE_BACKUP_DIR} with timestamp ${timestamp}.',
    ),
  );
  assert.ok(
    majorApplyScript.indexOf('trap finalize_remote_deploy EXIT') <
      majorApplyScript.indexOf('NGINX_MUTATED=1'),
    'the rollback guard must be armed before the first runtime file is installed',
  );
  assert.ok(
    majorApplyScript.indexOf('if ! verify_local_nginx_with_retry; then') <
      majorApplyScript.indexOf('DEPLOYMENT_COMMITTED=1'),
    'the deployment must remain rollback-eligible until the local smoke passes',
  );
});

test('Safety Desk keeps rollback state through a direct local nginx header smoke', () => {
  assert.ok(adminApplyScript.includes("curl --noproxy '*'"));
  assert.ok(adminApplyScript.includes('--resolve "${DOMAIN}:443:127.0.0.1"'));
  assert.ok(adminApplyScript.includes('if ! verify_local_admin_nginx_with_retry; then'));
  assert.ok(adminApplyScript.includes('restore_previous_nginx'));
  assert.ok(
    adminApplyScript.indexOf('if ! verify_local_admin_nginx_with_retry; then') <
      adminApplyScript.indexOf('rm -f "${REMOTE_TMP}"\nREMOTE'),
    'Safety Desk local smoke must run before the remote rollback context is released',
  );
});

test('Safety Desk retries the complete localhost smoke before rollback', () => {
  assert.ok(adminApplyScript.includes('LOCAL_ADMIN_SMOKE_MAX_ATTEMPTS=10'));
  assert.ok(adminApplyScript.includes('LOCAL_ADMIN_SMOKE_RETRY_DELAY_SECONDS=1'));
  assert.ok(adminApplyScript.includes('attempt <= LOCAL_ADMIN_SMOKE_MAX_ATTEMPTS'));
  assert.ok(adminApplyScript.includes('if verify_local_admin_nginx; then'));
  assert.ok(adminApplyScript.includes('sleep "${LOCAL_ADMIN_SMOKE_RETRY_DELAY_SECONDS}"'));
  assert.ok(
    adminApplyScript.includes(
      'failed: path=${LOCAL_ADMIN_SMOKE_FAILURE_PATH:-unknown} assertion=${LOCAL_ADMIN_SMOKE_FAILURE_ASSERTION:-unknown}.',
    ),
  );

  const retryCall = adminApplyScript.indexOf('if ! verify_local_admin_nginx_with_retry; then');
  const rollbackAfterRetry = adminApplyScript.indexOf(
    'if ! restore_previous_nginx; then',
    retryCall,
  );
  assert.ok(retryCall >= 0);
  assert.ok(rollbackAfterRetry > retryCall);
});

test('Safety Desk rolls back an incomplete certificate bootstrap before discarding backups', () => {
  assert.ok(adminApplyScript.includes('trap finalize_remote_deploy EXIT'));
  assert.ok(adminApplyScript.includes('NGINX_MUTATED=1'));
  assert.ok(adminApplyScript.includes('DEPLOYMENT_COMMITTED=1'));
  assert.ok(adminApplyScript.includes('ROLLBACK_ATTEMPTED=1'));
  assert.ok(adminApplyScript.includes('ROLLBACK_SUCCEEDED=1'));
  assert.ok(adminApplyScript.includes('if ! sudo certbot certonly'));
  assert.ok(adminApplyScript.includes('Certificate bootstrap failed for ${DOMAIN}.'));
  assert.ok(
    adminApplyScript.indexOf('trap finalize_remote_deploy EXIT') <
      adminApplyScript.indexOf('if ! sudo certbot certonly'),
    'the rollback guard must be armed before certificate bootstrap mutates nginx',
  );
  assert.ok(
    adminApplyScript.indexOf('if ! sudo certbot certonly') <
      adminApplyScript.indexOf('DEPLOYMENT_COMMITTED=1'),
    'certificate bootstrap must remain rollback-eligible until the final local smoke passes',
  );
});

test('legacy apply keeps rollback state through localhost SNI security smokes for both hosts', () => {
  assert.ok(legacyApplyScript.includes("curl --noproxy '*'"));
  assert.ok(
    legacyApplyScript.includes('local hosts=("maxim.play-team.ru" "hook.maxim.play-team.ru")'),
  );
  assert.ok(legacyApplyScript.includes('--resolve "${host}:443:127.0.0.1"'));
  for (const host of ['maxim.play-team.ru', 'hook.maxim.play-team.ru']) {
    assert.ok(
      legacyApplyScript.includes(`"${host}"`),
      `legacy apply must bypass DNS and edge routing for ${host}`,
    );
  }
  for (const path of [
    '/api/health/live',
    '/api/health/ready',
    '/api/v1/safety-desk/queue',
    '/api/v1/support-requests/queue',
  ]) {
    assert.ok(legacyApplyScript.includes(`"${path}"`));
  }
  assert.ok(legacyApplyScript.includes('/api/v1/system/metrics/queues'));
  assert.ok(
    legacyApplyScript.includes(
      'verify_local_redirect "maxim.play-team.ru" "/app/" "https://major-maksimov.ru/app/"',
    ),
  );
  assert.ok(legacyApplyScript.includes("'^HTTP/[0-9.]+ 308([[:space:]]|$)'"));
  assert.ok(legacyApplyScript.includes('"^location: ${expected_location}[[:space:]]*$"'));
  for (const path of [
    '/api/health/ready',
    '/api/v1/safety-desk/queue',
    '/api/v1/support-requests/queue',
  ]) {
    assert.ok(
      legacyApplyScript.includes(`"${path}" "404" "" 1`),
      `${path} must require the complete security header set`,
    );
  }
  assert.ok(legacyApplyScript.includes('if ! verify_local_nginx_with_retry; then'));
  assert.ok(legacyApplyScript.includes('trap finalize_remote_deploy EXIT'));

  const trapIndex = legacyApplyScript.indexOf('trap finalize_remote_deploy EXIT');
  const mutationIndex = legacyApplyScript.indexOf('NGINX_MUTATED=1', trapIndex);
  const smokeIndex = legacyApplyScript.indexOf('if ! verify_local_nginx_with_retry; then');
  const commitIndex = legacyApplyScript.lastIndexOf('DEPLOYMENT_COMMITTED=1');
  const remoteEndIndex = legacyApplyScript.indexOf('\nREMOTE\n', commitIndex);
  assert.ok(trapIndex >= 0 && trapIndex < mutationIndex);
  assert.ok(mutationIndex < smokeIndex);
  assert.ok(smokeIndex < commitIndex);
  assert.ok(
    commitIndex < remoteEndIndex,
    'local SNI smokes must pass before rollback context ends',
  );
});

test('legacy MAX app routes redirect to the canonical mini app without a retired static upstream', () => {
  assert.match(
    legacyConfig,
    /location = \/app \{\s+return 308 https:\/\/major-maksimov\.ru\/app\/\$is_args\$args;\s+\}/u,
  );
  assert.match(
    legacyConfig,
    /location \/app\/ \{\s+return 308 https:\/\/major-maksimov\.ru\$request_uri;\s+\}/u,
  );
  assert.doesNotMatch(legacyConfig, /proxy_pass http:\/\/127\.0\.0\.1:3000/u);
});

test('legacy apply retries local smokes and rolls back every incomplete post-mutation path', () => {
  assert.ok(legacyApplyScript.includes('LOCAL_SMOKE_MAX_ATTEMPTS=10'));
  assert.ok(legacyApplyScript.includes('LOCAL_SMOKE_RETRY_DELAY_SECONDS=1'));
  assert.ok(legacyApplyScript.includes('attempt <= LOCAL_SMOKE_MAX_ATTEMPTS'));
  assert.ok(legacyApplyScript.includes('if verify_local_nginx; then'));
  assert.ok(legacyApplyScript.includes('sleep "${LOCAL_SMOKE_RETRY_DELAY_SECONDS}"'));
  assert.ok(legacyApplyScript.includes('ROLLBACK_ATTEMPTED=0'));
  assert.ok(legacyApplyScript.includes('ROLLBACK_SUCCEEDED=0'));
  assert.ok(
    legacyApplyScript.includes(
      'Legacy nginx deployment failed after runtime mutation; rolling back.',
    ),
  );
  assert.ok(
    legacyApplyScript.includes(
      'Automatic nginx rollback failed; inspect the host before retrying.',
    ),
  );
  assert.ok(
    legacyApplyScript.includes(
      'Rollback backups retained under ${REMOTE_BACKUP_DIR} with timestamp ${timestamp}.',
    ),
  );
  assert.doesNotMatch(legacyApplyScript, /systemctl reload nginx \|\| true/u);
});
