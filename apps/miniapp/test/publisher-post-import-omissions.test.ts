import assert from 'node:assert/strict';
import test from 'node:test';
import { publisherPostImportSessionSchema } from '@maxim/contracts/publisher';
import { resolvePublisherPostImportPresentation } from '../src/features/publications/publisher-post-import-model';

test('post import reports omitted unsupported attachments without extra instructions', () => {
  const session = publisherPostImportSessionSchema.parse({
    id: 'session-attachments-omitted',
    status: 'ready',
    expiresAt: '2026-08-29T12:00:00.000Z',
    publicationId: 'publication-attachments-omitted',
    botUrl: null,
    failureCode: null,
    omissions: ['attachments_not_imported'],
  });

  assert.deepEqual(resolvePublisherPostImportPresentation(session), {
    title: 'Черновик готов',
    detail: 'Часть вложений не перенесена',
    tone: 'ready',
    action: 'open-draft',
  });
});

test('post import reports every omission in one compact status line', () => {
  const session = publisherPostImportSessionSchema.parse({
    id: 'session-combined-omissions',
    status: 'ready',
    expiresAt: '2026-08-29T12:00:00.000Z',
    publicationId: 'publication-combined-omissions',
    botUrl: null,
    failureCode: null,
    omissions: ['buttons_not_imported', 'attachments_not_imported', 'formatting_not_preserved'],
  });

  assert.equal(
    resolvePublisherPostImportPresentation(session)?.detail,
    'Не перенесены: часть вложений, кнопки · Форматирование упрощено',
  );
});
