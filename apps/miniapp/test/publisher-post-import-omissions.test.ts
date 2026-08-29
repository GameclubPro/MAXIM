import assert from 'node:assert/strict';
import test from 'node:test';
import { publisherPostImportSessionSchema } from '@maxim/contracts/publisher';
import {
  resolvePublisherPostImportDraftContext,
  resolvePublisherPostImportPresentation,
  shouldOfferPublisherButtonRecovery,
} from '../src/features/publications/publisher-post-import-model';

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

test('button recovery is offered only while an imported draft has no custom buttons', () => {
  assert.equal(shouldOfferPublisherButtonRecovery(['buttons_not_imported'], 0), true);
  assert.equal(shouldOfferPublisherButtonRecovery(['buttons_not_imported'], 1), false);
  assert.equal(shouldOfferPublisherButtonRecovery(['formatting_not_preserved'], 0), false);
});

test('ready import omissions survive a draft-only reopen only for the matching draft', () => {
  const session = publisherPostImportSessionSchema.parse({
    id: 'session-buttons-omitted',
    status: 'ready',
    expiresAt: '2026-08-29T12:00:00.000Z',
    publicationId: 'publication-buttons-omitted',
    botUrl: null,
    failureCode: null,
    omissions: ['buttons_not_imported'],
  });

  assert.deepEqual(resolvePublisherPostImportDraftContext(session, session.publicationId ?? ''), {
    sessionId: session.id,
    omissions: ['buttons_not_imported'],
  });
  assert.deepEqual(resolvePublisherPostImportDraftContext(session, 'another-publication'), {
    sessionId: null,
    omissions: [],
  });
});
