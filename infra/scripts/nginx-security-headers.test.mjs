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
