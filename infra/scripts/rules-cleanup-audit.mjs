import { pathToFileURL } from 'node:url';

export function buildRulesCleanupAuditSql(chatId, explain = false) {
  if (
    typeof chatId !== 'string' ||
    chatId.trim() !== chatId ||
    !/^-[1-9][0-9]{0,19}$/u.test(chatId)
  ) {
    throw new Error('rules-cleanup requires one negative numeric chat ID');
  }
  const query = `SELECT json_build_object(
  'audit', 'rules_cleanup',
  'chat_id', rules.chat_id,
  'published_message_id', left(rules.published_message_id, 256),
  'published_bot_id', left(rules.published_bot_id, 128),
  'publish_operation_id', left(rules.publish_operation_id, 128),
  'publish_send_started_at', rules.publish_send_started_at,
  'pending_cleanup_message_id', left(rules.pending_cleanup_message_id, 256),
  'pending_cleanup_bot_id', left(rules.pending_cleanup_bot_id, 128),
  'pending_cleanup_kind', left(rules.pending_cleanup_kind, 64),
  'pending_cleanup_intent_id', left(rules.pending_cleanup_intent_id, 128),
  'updated_at', rules.updated_at,
  'linked_intent_status', intent.status,
  'linked_intent_updated_at', intent.updated_at
)
FROM chat_rules rules
LEFT JOIN moderation_delete_intents intent ON intent.id = rules.pending_cleanup_intent_id
WHERE rules.chat_id = '${chatId}';`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [chatId, option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && option !== '--explain')) {
    throw new Error('Usage: rules-cleanup-audit.mjs <chat-id> [--explain]');
  }
  process.stdout.write(buildRulesCleanupAuditSql(chatId ?? '', option === '--explain'));
}
