import { LOCAL_USER_DISPLAY_NAME_EVENT_TYPES } from '../common/local-user-display-name-events';
import { buildLocalAdminContactDisplayNameQuery } from './local-admin-contact-display-name.query';

describe('buildLocalAdminContactDisplayNameQuery', () => {
  it('prioritizes read models and keeps the raw fallback aligned with its partial index', () => {
    const query = buildLocalAdminContactDisplayNameQuery('chat-1', 'user-1');
    const sql = query.strings.join('?').replace(/\s+/g, ' ').trim();

    expect(sql.indexOf('FROM chat_user_display_names')).toBeLessThan(
      sql.indexOf('FROM chat_membership_activity_events'),
    );
    expect(sql.indexOf('FROM chat_membership_activity_events')).toBeLessThan(
      sql.indexOf('FROM webhook_events'),
    );
    expect(sql).toContain('ORDER BY source_priority ASC, event_at DESC LIMIT 1');
    expect(sql).toContain("NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') = ?");
    expect(sql).toContain("NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') = ?");
    expect(sql).toContain("normalized_payload->>'type' IN (?");
    expect(query.values).toEqual([
      'chat-1',
      'user-1',
      'chat-1',
      'user-1',
      'chat-1',
      'user-1',
      ...LOCAL_USER_DISPLAY_NAME_EVENT_TYPES,
    ]);
  });
});
