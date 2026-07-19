import { BadRequestException } from '@nestjs/common';
import {
  buildLegacyManagedBroadcastUpcomingSlots,
  buildManagedBroadcastCalendarReservationRows,
  buildManagedBroadcastDeliveryRows,
  normalizeManagedBroadcastTargetChatIds,
  parseManagedBroadcastCalendarSlots,
  parseManagedBroadcastSendAt,
  resolveManagedBroadcastTargetsFromRow,
} from './admin-managed-broadcast-planner';
import { ChatEntityType, ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';

describe('admin managed broadcast planner', () => {
  it('normalizes selected targets and preserves the current-chat fallback', () => {
    expect(normalizeManagedBroadcastTargetChatIds([' chat-2 ', 'chat-2', ''])).toEqual(['chat-2']);
    expect(
      resolveManagedBroadcastTargetsFromRow({
        applyToAllChats: false,
        sourceChatId: 'chat-1',
        targetChatIds: [],
      }),
    ).toEqual({ targetMode: 'current', targetChatIds: ['chat-1'] });
  });

  it('builds deterministic legacy slots and deduplicated calendar reservations', () => {
    const start = new Date('2026-07-20T09:00:00.000Z');
    const slots = buildLegacyManagedBroadcastUpcomingSlots(start, 3, 6);
    expect(slots.map((slot) => slot.toISOString())).toEqual([
      '2026-07-20T09:00:00.000Z',
      '2026-07-20T15:00:00.000Z',
      '2026-07-20T21:00:00.000Z',
    ]);
    expect(
      buildManagedBroadcastCalendarReservationRows(
        'broadcast-1',
        'chat-1',
        ChatEntityType.CHAT,
        2,
        slots.slice(0, 1),
        ['chat-2', ' chat-2 ', 'chat-3'],
      ),
    ).toEqual([
      expect.objectContaining({ occurrenceIndex: 2, targetChatId: 'chat-2' }),
      expect.objectContaining({ occurrenceIndex: 2, targetChatId: 'chat-3' }),
    ]);
    expect(buildManagedBroadcastDeliveryRows('broadcast-1', ['chat-2'], 2, 2)).toEqual([
      {
        broadcastId: 'broadcast-1',
        occurrenceIndex: 2,
        targetChatId: 'chat-2',
        status: ManagedBroadcastDeliveryStatus.PENDING,
      },
    ]);
  });

  it('keeps past-today calendar slots as sent while returning future slots', async () => {
    const result = await parseManagedBroadcastCalendarSlots(
      ['2026-07-20T08:00:00.000Z', '2026-07-20T10:00:00.000Z'],
      0,
      'UTC',
      new Date('2026-07-20T09:00:00.000Z'),
    );
    expect(result.sentCount).toBe(1);
    expect(result.upcomingSlots.map((slot) => slot.toISOString())).toEqual([
      '2026-07-20T10:00:00.000Z',
    ]);
  });

  it('rejects send times outside the existing 30-second window', () => {
    expect(() =>
      parseManagedBroadcastSendAt(
        '2026-07-20T09:00:29.000Z',
        { required: true, sentCount: 0 },
        Date.parse('2026-07-20T09:00:00.000Z'),
      ),
    ).toThrow(BadRequestException);
  });
});
