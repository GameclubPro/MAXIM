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
  assert.ok(majorApplyScript.includes('if ! verify_local_nginx; then'));
  assert.ok(majorApplyScript.includes('site_index_backup='));
  assert.ok(majorApplyScript.includes('/api/v1/system/metrics/queues'));
  assert.ok(majorApplyScript.includes('if ! restore_backup; then'));
  assert.ok(
    majorApplyScript.includes('Automatic nginx rollback failed; inspect the host before retrying.'),
  );
  assert.ok(
    majorApplyScript.indexOf('if ! verify_local_nginx; then') <
      majorApplyScript.indexOf('cleanup_tmp\nREMOTE'),
    'major local smoke must run before the remote rollback context is released',
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
    majorApplyScript.indexOf('if ! verify_local_nginx; then') <
      majorApplyScript.indexOf('DEPLOYMENT_COMMITTED=1'),
    'the deployment must remain rollback-eligible until the local smoke passes',
  );
});

test('Safety Desk keeps rollback state through a direct local nginx header smoke', () => {
  assert.ok(adminApplyScript.includes("curl --noproxy '*'"));
  assert.ok(adminApplyScript.includes('--resolve "${DOMAIN}:443:127.0.0.1"'));
  assert.ok(adminApplyScript.includes('if ! verify_local_admin_nginx; then'));
  assert.ok(adminApplyScript.includes('restore_previous_nginx'));
  assert.ok(
    adminApplyScript.indexOf('if ! verify_local_admin_nginx; then') <
      adminApplyScript.indexOf('rm -f "${REMOTE_TMP}"\nREMOTE'),
    'Safety Desk local smoke must run before the remote rollback context is released',
  );
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
