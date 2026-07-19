import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { findDocumentationViolations } from './check-docs.mjs';

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function fixture(markdown) {
  const root = mkdtempSync(join(tmpdir(), 'maxim-docs-guard-'));
  write(root, 'package.json', JSON.stringify({ scripts: { check: 'node ok.mjs' } }));
  write(root, 'README.md', markdown);
  write(root, 'infra/docker-compose.yml', 'services:\n  api-admin:\n    image: busybox\n');
  execFileSync('docker', ['compose', '-f', 'infra/docker-compose.yml', 'config'], { cwd: root });
  return root;
}

test('accepts executable checked-in commands', () => {
  const root = fixture(
    '```bash\nnpm run check\ndocker compose -f infra/docker-compose.yml logs api-admin\n```\n',
  );
  assert.deepEqual(findDocumentationViolations(root), []);
});

test('rejects missing scripts, placeholders, dormant delivery commands, and unknown services', () => {
  const root = fixture(
    '```bash\nnpm run missing\n./deploy.sh <service>\nyc storage cp ./dist s3://bucket/app2.major-maksimov.ru\ndocker compose -f infra/docker-compose.yml logs api\n```\n',
  );
  const messages = findDocumentationViolations(root).join('\n');
  assert.match(messages, /missing root npm script/u);
  assert.match(messages, /angle-bracket placeholder/u);
  assert.match(messages, /dormant CDN\/Object Storage/u);
  assert.match(messages, /unknown Compose service api/u);
});

test('parses adversarial Compose-like command text without backtracking', () => {
  const root = fixture(`\`\`\`bash\ndocker composerun ${'-! '.repeat(50_000)}!\n\`\`\`\n`);

  assert.deepEqual(findDocumentationViolations(root), []);
});

test('finds a Compose service after a long sequence of flags', () => {
  const root = fixture(
    `\`\`\`bash\ndocker compose logs ${'--follow '.repeat(10_000)}missing-service\n\`\`\`\n`,
  );

  assert.match(
    findDocumentationViolations(root).join('\n'),
    /unknown Compose service missing-service/u,
  );
});

test('preserves Compose parsing across ECMAScript whitespace', () => {
  const root = fixture('```bash\ndocker\u00a0compose\u00a0logs\u00a0missing-service\n```\n');

  assert.match(
    findDocumentationViolations(root).join('\n'),
    /unknown Compose service missing-service/u,
  );
});
