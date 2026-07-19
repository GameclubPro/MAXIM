import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSupportAttachmentUrl,
  sanitizeExternalHttpUrl,
  sanitizeSafetyDeskPreviewHtml,
} from '../src/safety-desk-preview-security';

test('allows only absolute HTTP and HTTPS preview URLs', () => {
  assert.equal(
    sanitizeExternalHttpUrl(' https://cdn.example/photo.jpg '),
    'https://cdn.example/photo.jpg',
  );
  assert.equal(
    sanitizeExternalHttpUrl('http://cdn.example/video.mp4'),
    'http://cdn.example/video.mp4',
  );

  for (const value of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'max://bot/action',
    'blob:https://admin.example/id',
    '//cdn.example/photo.jpg',
    '/relative/photo.jpg',
  ]) {
    assert.equal(sanitizeExternalHttpUrl(value), null, value);
  }
});

test('uses a safe attachment payload URL when the direct URL has a blocked protocol', () => {
  assert.equal(
    resolveSupportAttachmentUrl({
      type: 'image',
      fileName: null,
      mimeType: null,
      url: 'javascript:alert(1)',
      payload: {
        preview_url: 'https://cdn.example/safe-preview.jpg',
        href: 'data:text/html,unsafe',
      },
    }),
    'https://cdn.example/safe-preview.jpg',
  );
});

test('removes executable preview HTML while preserving supported formatting', () => {
  const sanitized = sanitizeSafetyDeskPreviewHtml(
    '<p onclick="alert(1)">Привет<script>alert(1)</script><img src=x onerror=alert(2)>' +
      '<strong style="color:red">мир</strong><a href="javascript:alert(3)">ссылка</a></p>' +
      '<svg><script>alert(4)</script></svg><pre>&lt;код&gt;</pre><!-- hidden -->',
  );

  assert.equal(sanitized, '<p>Привет<strong>мир</strong>ссылка</p><pre>&lt;код&gt;</pre>');
  assert.equal(/script|onerror|onclick|javascript|svg/iu.test(sanitized), false);
});
