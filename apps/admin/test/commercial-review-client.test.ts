import assert from 'node:assert/strict';
import test from 'node:test';
import { commercialReviewItemSchema } from '@maxim/contracts/safety-desk';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';

const item = commercialReviewItemSchema.parse({
  id: 'sample/1',
  chatId: 'chat-1',
  chatTitle: 'Чат',
  source: 'TEXT',
  excerpt: 'Ремонт',
  score: 85,
  actionBand: 'DELETE_ONLY',
  messageDisposition: 'DELETE',
  requiredPolicyCohorts: ['commercial-text'],
  detectorVersion: 'v1',
  decisionFingerprint: 'fingerprint',
  reviewPriority: 90,
  reasons: ['SERVICE_OFFER'],
  label: null,
  reviewReason: '',
  reviewedAt: null,
  observedAt: '2026-10-01T10:00:00.000Z',
  expiresAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

test('commercial owner feedback sends the server revision through the closed transport', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(
          String(url).endsWith('/label')
            ? { ...item, label: 'NOT_COMMERCIAL' }
            : { generatedAt: item.updatedAt, items: [item], nextCursor: null },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  await client.fetchCommercialReview('private-code', 'page', 'REVIEWED');
  await client.labelCommercialReview(item, 'NOT_COMMERCIAL', 'Частное объявление', 'private-code');
  assert.equal(
    calls[0]?.url,
    '/api/v1/safety-desk/commercial/review?limit=50&status=REVIEWED&cursor=page',
  );
  assert.equal(calls[1]?.url, '/api/v1/safety-desk/commercial/review/sample%2F1/label');
  assert.equal(calls[1]?.init?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    expectedUpdatedAt: item.updatedAt,
    label: 'NOT_COMMERCIAL',
    reason: 'Частное объявление',
  });
  assert.equal(
    (calls[1]?.init?.headers as Record<string, string>)['X-Admin-Access-Code'],
    'private-code',
  );
});
