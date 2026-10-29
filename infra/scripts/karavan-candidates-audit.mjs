import { pathToFileURL } from 'node:url';

export const KARAVAN_CANDIDATE_COLUMNS = {
  karavan_marketplace_candidate_settings: [
    'settings_id',
    'chat_id',
    'chat_title',
    'entity_type',
    'enabled',
    'admins_only',
  ],
  karavan_marketplace_candidate_events: [
    'id',
    'chat_id',
    'action',
    'created_at',
    'storefront_field_touched',
    'relay_status',
    'relay_sent_confirmed',
  ],
};
const values = Object.entries(KARAVAN_CANDIDATE_COLUMNS)
  .flatMap(([table, columns]) => columns.map((column) => `('${table}','${column}')`))
  .join(',');
export function parseKaravanCandidateArgs(args) {
  const result = { after: '', limit: 40, explain: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error('Duplicate inventory argument');
    seen.add(arg);
    if (arg === '--explain' && !result.explain) result.explain = true;
    else if (arg === '--after' && result.after === '') {
      const value = args[++index];
      if (!/^[A-Za-z0-9_-]{1,100}$/u.test(value ?? ''))
        throw new Error('Expected one exact settings cursor');
      result.after = value;
    } else if (arg === '--limit' && result.limit === 40) {
      const value = args[++index];
      if (!/^(?:[1-9]|[1-3][0-9]|40)$/u.test(value ?? ''))
        throw new Error('Expected page size 1..40');
      result.limit = Number(value);
    } else
      throw new Error(
        'Usage: karavan-candidates [--after settings-id] [--limit 1..40] [--explain]',
      );
  }
  return result;
}
export function buildKaravanCandidatePrivilegesSql(requireAll = false) {
  return `WITH allowed(table_name,column_name) AS (VALUES ${values}), effective AS (
    SELECT relation.relname AS table_name,attribute.attname AS column_name FROM pg_class relation
    JOIN pg_namespace ns ON ns.oid=relation.relnamespace JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
    WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
      AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
  ) SELECT NOT EXISTS(SELECT * FROM effective EXCEPT SELECT * FROM allowed)
    AND (SELECT count(*) FROM effective) IN (${requireAll ? '' : '0,'}13)
    AND NOT has_table_privilege('maxim_audit','public.audit_logs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.audit_logs'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('maxim_audit',a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES'))
    AND NOT EXISTS(SELECT 1 FROM pg_class r JOIN pg_namespace ns ON ns.oid=r.relnamespace WHERE ns.nspname='public' AND r.relname IN (SELECT table_name FROM allowed)
      AND (has_table_privilege('maxim_audit',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('maxim_audit',r.oid,a.attnum,'INSERT,UPDATE,REFERENCES'))))
    AS karavan_candidate_privileges_ready \\gset
\\if :karavan_candidate_privileges_ready
\\else
\\echo MAXIM_KARAVAN_CANDIDATE_PRIVILEGES_UNAVAILABLE
SELECT 1 / 0;
\\endif\n`;
}
export function buildKaravanCandidateProvisionSql() {
  return `DO $karavan_candidates$ BEGIN
    IF to_regclass('public.karavan_marketplace_candidate_settings') IS NOT NULL AND to_regclass('public.karavan_marketplace_candidate_events') IS NOT NULL THEN
      GRANT SELECT(settings_id,chat_id,chat_title,entity_type,enabled,admins_only) ON public.karavan_marketplace_candidate_settings TO maxim_audit;
      GRANT SELECT(id,chat_id,action,created_at,storefront_field_touched,relay_status,relay_sent_confirmed) ON public.karavan_marketplace_candidate_events TO maxim_audit;
    END IF;
  END $karavan_candidates$;\n`;
}
export function buildKaravanCandidateIndexSql() {
  return `SELECT count(*)=2 AS karavan_candidate_indexes_ready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname='public' AND c.relname IN ('chat_settings_pkey','audit_logs_chat_action_created_at_idx') AND i.indisvalid AND i.indisready \\gset
\\if :karavan_candidate_indexes_ready
\\else
\\echo MAXIM_KARAVAN_CANDIDATE_INDEXES_UNAVAILABLE
SELECT 1 / 0;
\\endif\n`;
}
export function buildKaravanCandidateQuery(args) {
  const { after, limit } = parseKaravanCandidateArgs(args);
  return `WITH page_probe AS MATERIALIZED (
    SELECT settings_id,chat_id,chat_title,entity_type,enabled,admins_only FROM public.karavan_marketplace_candidate_settings
    WHERE settings_id>'${after}' ORDER BY settings_id LIMIT ${limit + 1}
  ), page AS MATERIALIZED (SELECT * FROM page_probe ORDER BY settings_id LIMIT ${limit}),
  candidates AS MATERIALIZED (SELECT * FROM page WHERE entity_type='CHAT' AND enabled),
  evidence AS MATERIALIZED (
    SELECT c.*,settings.touched,settings.last_touch,settings.settings_capped,relay.used,relay.sent,relay.uncertain,relay.last_relay,relay.relay_capped
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT bool_or(storefront_field_touched) AS touched,max(created_at) FILTER(WHERE storefront_field_touched) AS last_touch,count(*)>64 AS settings_capped
      FROM (SELECT storefront_field_touched,created_at FROM public.karavan_marketplace_candidate_events WHERE chat_id=c.chat_id AND action='UPDATE_SETTINGS'
        AND created_at>=statement_timestamp()-interval '30 days' ORDER BY created_at DESC LIMIT 65) bounded_settings
    ) settings ON true
    LEFT JOIN LATERAL (
      SELECT count(*)>0 AS used,bool_or(relay_sent_confirmed) AS sent,bool_or(relay_status IN('pending','queued','ambiguous','unconfirmed')) AS uncertain,max(created_at) AS last_relay,count(*)>64 AS relay_capped
      FROM (SELECT relay_sent_confirmed,relay_status,created_at FROM public.karavan_marketplace_candidate_events WHERE chat_id=c.chat_id AND action='KARAVAN_STOREFRONT_RELAY'
        AND created_at>=statement_timestamp()-interval '30 days' ORDER BY created_at DESC LIMIT 65) bounded_relays
    ) relay ON true
  ) SELECT json_build_object('schemaVersion',1,'report','karavan_candidates','readOnly',true,'migrationAuthorized',false,
    'sampledAt',statement_timestamp(),'windowDays',30,'settingsPageLimit',${limit},'auditProbeLimitPerChatAction',65,
    'scannedSettings',(SELECT count(*) FROM page),'hasMore',(SELECT count(*)>${limit} FROM page_probe),
    'nextCursor',CASE WHEN (SELECT count(*)>${limit} FROM page_probe) THEN (SELECT max(settings_id) FROM page) ELSE NULL END,
    'candidateCountOnPage',(SELECT count(*) FROM candidates),
    'candidates',coalesce((SELECT json_agg(json_build_object('chatId',chat_id,'title',chat_title,'enabled',enabled,'adminsOnly',admins_only,
      'storefrontFieldTouched',coalesce(touched,false),'lastSettingTouch',last_touch,'settingsEvidenceCapped',settings_capped,
      'relayObserved',used,'confirmedRelayObserved',coalesce(sent,false),'unconfirmedRelayObserved',coalesce(uncertain,false),'lastRelay',last_relay,'relayEvidenceCapped',relay_capped,
      'ownershipEstablished',false,'requiresAdministratorConsent',true) ORDER BY settings_id) FROM evidence),'[]'::json)) AS report`;
}
export function buildKaravanCandidateAuditSql(args) {
  const { explain } = parseKaravanCandidateArgs(args);
  return (
    buildKaravanCandidateIndexSql() +
    (explain ? 'EXPLAIN (FORMAT JSON)\n' : '') +
    buildKaravanCandidateQuery(args) +
    ';\n'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (
      args[0] === '--privileges' &&
      args.every((arg) => ['--privileges', '--require-all'].includes(arg))
    )
      process.stdout.write(buildKaravanCandidatePrivilegesSql(args.includes('--require-all')));
    else if (args.length === 1 && args[0] === '--provision')
      process.stdout.write(buildKaravanCandidateProvisionSql());
    else if (args[0] === '--validate-scope') parseKaravanCandidateArgs(args.slice(1));
    else process.stdout.write(buildKaravanCandidateAuditSql(args));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
