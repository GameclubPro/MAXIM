import { pathToFileURL } from 'node:url';

export function buildPublisherCommentsAuditSql(chatId, explain = false) {
  if (typeof chatId !== 'string' || !/^-[1-9][0-9]{0,19}$/u.test(chatId)) {
    throw new Error('publisher-comments requires one negative numeric chat ID');
  }
  const query = `SELECT json_build_object(
  'audit', 'publisher_comments',
  'binding_present', binding.chat_id IS NOT NULL,
  'binding_status', binding.status,
  'access_state', binding.bot_access_state,
  'access_checked_at', binding.bot_access_checked_at,
  'access_expires_at', binding.bot_access_expires_at,
  'access_expired', binding.bot_access_expires_at <= statement_timestamp(),
  'quarantined', binding.send_route_quarantined_until > statement_timestamp(),
  'publik_enabled', coalesce(policy.publik_enabled, true),
  'chat_comments_enabled', coalesce(settings.chat_comments_enabled, false),
  'chat_admin_comments_enabled', coalesce(settings.chat_comments_admins_enabled, false),
  'chat_post_comments_enabled', coalesce(settings.chat_comments_posts_enabled, false),
  'channel_comments_enabled', coalesce(settings.channel_comments_enabled, false),
  'settings_updated_at', settings.updated_at
)
FROM (VALUES ('${chatId}')) AS target(chat_id)
LEFT JOIN publisher_entity_bindings binding ON binding.chat_id = target.chat_id
LEFT JOIN publisher_entity_settings settings ON settings.chat_id = target.chat_id
LEFT JOIN managed_entity_publication_policies policy ON policy.chat_id = target.chat_id;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [chatId, option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && option !== '--explain')) {
    throw new Error('Usage: publisher-comments-audit.mjs <chat-id> [--explain]');
  }
  process.stdout.write(buildPublisherCommentsAuditSql(chatId, option === '--explain'));
}
