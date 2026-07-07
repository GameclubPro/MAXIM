import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedEntityAccessDiagnostics } from '@maxim/contracts/managed-entities';
import { formatManagedEntityAccessLossHeadline } from '../src/components/managed-entity-access-diagnostics';

function createDiagnostics(
  overrides: Partial<ManagedEntityAccessDiagnostics> = {},
): ManagedEntityAccessDiagnostics {
  return {
    state: 'bot_access_lost',
    lastDetectedAt: '2026-07-07T06:00:00.000Z',
    lastCheckedAt: '2026-07-07T06:00:00.000Z',
    freshUntil: null,
    source: 'access_edge',
    activeBotCount: 0,
    lostBots: [
      {
        botId: 'bot-1',
        botLabel: 'Первый бот',
        reason: 'bot_denied',
        detectedAt: '2026-07-07T06:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

test('access loss headline stays bot-scoped when another bot still has access', () => {
  const headline = formatManagedEntityAccessLossHeadline(
    createDiagnostics({ activeBotCount: 2 }),
    'чат',
  );

  assert.equal(headline, '1 бот · 2 бота продолжают работать');
  assert.equal(headline.includes('чат недоступен'), false);
});

test('access loss headline marks the entity unavailable only when no bots remain active', () => {
  const lostBot = createDiagnostics().lostBots[0]!;

  assert.equal(
    formatManagedEntityAccessLossHeadline(createDiagnostics(), 'чат'),
    '1 бот · чат недоступен',
  );
  assert.equal(
    formatManagedEntityAccessLossHeadline(
      createDiagnostics({ lostBots: [lostBot, lostBot] }),
      'канал',
    ),
    '2 бота · канал недоступен',
  );
});
