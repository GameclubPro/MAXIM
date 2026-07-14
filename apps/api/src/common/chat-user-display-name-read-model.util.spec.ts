import {
  buildChatUserDisplayNameInsertIfAbsent,
  buildChatUserDisplayNameUpsert,
  normalizeChatUserDisplayNameObservation,
} from './chat-user-display-name-read-model.util';

function sqlText(query: unknown): string {
  const value = query as { strings?: readonly string[]; values?: readonly unknown[] };
  const nested = (value.values ?? []).map(sqlText).join(' ');
  return `${value.strings?.join(' ') ?? ''} ${nested}`;
}

describe('chat user display-name read model SQL', () => {
  it('ignores incomplete observations and guards snapshot writes against stale events', () => {
    expect(
      normalizeChatUserDisplayNameObservation({
        chatId: 'chat-1',
        userId: 'user-1',
        displayName: '   ',
        observedAt: new Date('2026-07-14T00:00:00.000Z'),
        sourceEventId: 'evt-1',
        sourceKind: 'message_created:sender',
      }),
    ).toBeNull();

    const query = buildChatUserDisplayNameUpsert([
      {
        chatId: 'chat-1',
        userId: 'user-1',
        displayName: 'Мария',
        observedAt: new Date('2026-07-14T00:00:00.000Z'),
        sourceEventId: 'evt-1',
        sourceKind: 'message_created:sender',
      },
    ]);

    const normalizedSql = sqlText(query).replace(/\s+/g, ' ');
    expect(normalizedSql).toContain('INSERT INTO "chat_user_display_names"');
    expect(normalizedSql).toContain('ON CONFLICT ("chat_id", "user_id") DO UPDATE SET');
    expect(normalizedSql).toContain(
      'EXCLUDED."observed_at" > "chat_user_display_names"."observed_at"',
    );
    expect(normalizedSql).toContain(
      'EXCLUDED."source_event_id" > "chat_user_display_names"."source_event_id"',
    );
  });

  it('uses insert-only writes for observations with an ingress-generated timestamp', () => {
    const query = buildChatUserDisplayNameInsertIfAbsent([
      {
        chatId: 'chat-1',
        userId: 'user-1',
        displayName: 'Мария',
        observedAt: new Date('2026-07-14T00:00:00.000Z'),
        sourceEventId: 'evt-1',
        sourceKind: 'user_added:sender:ingress',
      },
    ]);

    const normalizedSql = sqlText(query).replace(/\s+/g, ' ');
    expect(normalizedSql).toContain('INSERT INTO "chat_user_display_names"');
    expect(normalizedSql).toContain('ON CONFLICT ("chat_id", "user_id") DO NOTHING');
    expect(normalizedSql).not.toContain('DO UPDATE SET');
  });
});
