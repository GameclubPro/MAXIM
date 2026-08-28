import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEditorLinkHref, serializeEditorLinkMarkdown } from '../src/lib/max-rich-text-link';

test('editor links allow only canonical HTTPS and MAX URLs', () => {
  assert.equal(
    parseEditorLinkHref(' HTTPS://Example.COM:443/a b?query=hello world '),
    'https://example.com/a%20b?query=hello%20world',
  );
  assert.equal(parseEditorLinkHref('max://user/hello world'), 'max://user/hello%20world');
  assert.equal(parseEditorLinkHref('example.com/path'), 'https://example.com/path');
  assert.equal(
    parseEditorLinkHref('https://example.com/<script>'),
    'https://example.com/%3Cscript%3E',
  );
  assert.equal(parseEditorLinkHref('https://example.com/foo)bar'), 'https://example.com/foo%29bar');
});

test('editor links reject disallowed protocols and malformed URLs', () => {
  for (const value of [
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/file',
    '//example.com/path',
    'httpsx://example.com/path',
    'maxx://user/path',
    'max:javascript:alert(1)',
    'max:/settings',
    'max:///user/1',
    'max://bot/action',
    'max://user/one/two',
    'max://user/123?start=unsafe',
    'https://name:secret@example.com/path',
    'https://[invalid',
  ]) {
    assert.equal(parseEditorLinkHref(value), null, value);
  }
});

test('editor links reject ASCII controls before URL parsing', () => {
  for (const value of [
    'https://example.com/\njavascript:alert(1)',
    'https://example.com/\rpath',
    '\thttps://example.com',
    'https://example.com/\u0000path',
    'https://example.com/\u007fpath',
  ]) {
    assert.equal(parseEditorLinkHref(value), null, JSON.stringify(value));
  }
});

test('editor link Markdown uses the canonical parsed href and drops unsafe hrefs', () => {
  assert.equal(
    serializeEditorLinkMarkdown('Документация', 'HTTPS://Example.COM:443/a b'),
    '[Документация](https://example.com/a%20b)',
  );
  assert.equal(
    serializeEditorLinkMarkdown('Небезопасная ссылка', 'http://example.com'),
    'Небезопасная ссылка',
  );
  assert.equal(serializeEditorLinkMarkdown('', 'https://example.com'), '');
  const injected = serializeEditorLinkMarkdown(
    'Документация',
    'https://example.com/foo)[bad](https://evil.example',
  );
  assert.equal(
    injected,
    '[Документация](https://example.com/foo%29%5Bbad%5D%28https://evil.example)',
  );
  assert.equal(injected.includes(')[bad]('), false);
});

test('editor links serialize each non-empty line independently', () => {
  assert.equal(
    serializeEditorLinkMarkdown('🔥 Первая\n\nВторая', 'https://example.com/path'),
    '[🔥 Первая](https://example.com/path)\n\n[Вторая](https://example.com/path)',
  );
});
