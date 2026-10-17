const migration = (name, checksum) => Object.freeze({ name, checksum });
const defaultsDisabled = migration(
  '20260726120000_disable_bot_settings_defaults',
  '52daa544eaba9ee2909fe0c682ac86c80c12512345bdd43213c9e085ed75fc83',
);
const nightReplacement = migration(
  '20260316113000_add_night_mode_open_message',
  '466d063dcb6ffcb85fa4d5f6eb6dd305bd4a2cd9b0203a5885b4bd9dd19fcbce',
);

// FLAG: These four exact historical SQL hashes are exceptions only when the pinned
// current source, successful successor receipts and current catalog all agree.
// This policy never repairs receipts, runs old SQL or infers historical data values.
export const OUTCOME_COHORT_HISTORICAL_COMPATIBILITY = Object.freeze([
  Object.freeze({
    name: '20260301143000_add_commercial_scoring_settings',
    checksum: 'bf0f08ea91e490406c5f04fe78895bdacd41eb2a475054b4b509390126068c99',
    sourceChecksum: 'e718cae762919f84d823efae0f6ddf5403c1671a22714ab4b84b0a3b2ed5c426',
    successors: Object.freeze([
      migration(
        '20260301150000_drop_commercial_phrase_tables',
        '8fa7a5de15fa436812a13e774b9822757830a7f79ef816b2d708818f6a2ce3ca',
      ),
      migration(
        '20260302012000_remove_unmanaged_chat_settings_fields',
        '19a3d823cfb97064e247e8ae91c1baf19f3c9a4eaa57ddd9239c2e46342f6c72',
      ),
    ]),
    catalog: 'commercial',
  }),
  Object.freeze({
    name: '20260301173000_add_delete_bots_messages_toggle',
    checksum: 'e2be732e2c92320c22f82d89d827479532e256039ceb97e7316e200c983ee55e',
    sourceChecksum: '2f6f82088a69b1234a1777717f4a41c84d377c765ad12ed7aaae7cf098d87f72',
    successors: Object.freeze([
      migration(
        '20260314153000_enable_remove_bots_from_group_by_default',
        'ab6b85a6d75ed327483447b10766729b20aab25e004398532844e4803c5badc6',
      ),
      defaultsDisabled,
    ]),
    catalog: 'remove_bots',
  }),
  Object.freeze({
    name: '20260311153000_add_night_mode_open_message_enabled',
    checksum: '6327681695854247dfe8d06a42f917ed6d2af9a61fce10cdff718446219c072b',
    sourceChecksum: null,
    successors: Object.freeze([nightReplacement, defaultsDisabled]),
    catalog: 'night',
  }),
  Object.freeze({
    name: '20260311160000_add_night_mode_open_message_text',
    checksum: '65b381f01dcd3e2870c9290118941d8ee88f977c67232ba31332d730e9c9dc2b',
    sourceChecksum: null,
    successors: Object.freeze([nightReplacement, defaultsDisabled]),
    catalog: 'night',
  }),
]);

const successful = (receipt) =>
  receipt?.finished === true &&
  receipt.rolled_back === false &&
  Number.isInteger(receipt.steps) &&
  receipt.steps >= 0;

export function isCompatibleHistoricalReceipt(receipt, known, active, proof) {
  if (!(known instanceof Map) || !(active instanceof Map)) return false;
  const rule = OUTCOME_COHORT_HISTORICAL_COMPATIBILITY.find(
    (candidate) => candidate.name === receipt?.name && candidate.checksum === receipt?.checksum,
  );
  if (!rule || !successful(receipt) || receipt.steps !== 1) return false;
  const retained = active.get(rule.name);
  if (
    !successful(retained) ||
    retained.steps !== 1 ||
    retained.name !== rule.name ||
    retained.checksum !== rule.checksum
  )
    return false;
  if (
    rule.sourceChecksum === null
      ? known.has(rule.name)
      : known.get(rule.name) !== rule.sourceChecksum
  )
    return false;
  for (const successor of rule.successors) {
    const applied = active.get(successor.name);
    if (
      known.get(successor.name) !== successor.checksum ||
      !successful(applied) ||
      applied.name !== successor.name ||
      applied.checksum !== successor.checksum
    )
      return false;
  }
  if (!Array.isArray(proof) || proof.length !== OUTCOME_COHORT_HISTORICAL_COMPATIBILITY.length)
    return false;
  const seen = new Map();
  for (const entry of proof) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, 'name') ||
      !Object.hasOwn(entry, 'exact') ||
      typeof entry.exact !== 'boolean' ||
      !OUTCOME_COHORT_HISTORICAL_COMPATIBILITY.some((candidate) => candidate.name === entry.name) ||
      seen.has(entry.name)
    )
      return false;
    seen.set(entry.name, entry.exact);
  }
  return seen.get(rule.name) === true;
}

// FLAG: Only fixed pg_catalog lookups belong in the collector's existing bounded
// readonly snapshot. A default expression is inspected, never executed. The enum
// spelling uses its exact public OID so search_path cannot substitute another type.
export const historicalCompatibilityCtes = `historical_relation AS MATERIALIZED (
  SELECT relation.oid,
    COALESCE(relation.relkind = 'r' AND relation.relpersistence = 'p'
      AND relation.reltablespace = 0 AND NOT relation.relhassubclass
      AND NOT relation.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inheritance
        WHERE inheritance.inhrelid=relation.oid OR inheritance.inhparent=relation.oid), false) AS exact
  FROM (SELECT pg_catalog.to_regclass('public.chat_settings') AS oid) expected
  LEFT JOIN pg_catalog.pg_class relation ON relation.oid=expected.oid
), historical_expected_columns(family, name, type_name, default_sql, optional) AS (VALUES
  ('commercial','commercial_ads_sensitivity','public."CommercialAdsSensitivity"',
    pg_catalog.quote_literal('BALANCED') || '::' ||
      pg_catalog.format_type(pg_catalog.to_regtype('public."CommercialAdsSensitivity"'),NULL),false),
  ('commercial','commercial_ads_warn_threshold','pg_catalog.int4','45',false),
  ('commercial','commercial_ads_delete_threshold','pg_catalog.int4','65',false),
  ('remove_bots','remove_bots_from_group_enabled','pg_catalog.bool','false',false),
  ('remove_bots','delete_bots_messages_enabled','pg_catalog.bool','false',true),
  ('night','night_mode_open_message_enabled','pg_catalog.bool','false',false),
  ('night','night_mode_open_message_text','pg_catalog.text',
    pg_catalog.quote_literal('') || '::' || pg_catalog.format_type('pg_catalog.text'::regtype,NULL),false)
), historical_columns AS MATERIALIZED (
  SELECT expected.family, expected.name,
    CASE WHEN attribute.attname IS NULL AND expected.optional THEN true ELSE
      COALESCE(attribute.attnum > 0 AND NOT attribute.attisdropped
        AND attribute.atttypid=pg_catalog.to_regtype(expected.type_name)
        AND attribute.atttypmod = -1 AND attribute.attndims = 0
        AND attribute.attnotnull AND attribute.atthasdef
        AND attribute.attgenerated = '' AND attribute.attidentity = ''
        AND attribute.attislocal AND attribute.attinhcount = 0
        AND attribute.attcollation = definition.typcollation
        AND pg_catalog.pg_get_expr(defaults.adbin,defaults.adrelid,false)=expected.default_sql,
        false) END AS exact
  FROM historical_expected_columns expected CROSS JOIN historical_relation relation
  LEFT JOIN pg_catalog.pg_attribute attribute
    ON attribute.attrelid=relation.oid AND attribute.attname=expected.name AND NOT attribute.attisdropped
  LEFT JOIN pg_catalog.pg_type definition ON definition.oid=attribute.atttypid
  LEFT JOIN pg_catalog.pg_attrdef defaults
    ON defaults.adrelid=attribute.attrelid AND defaults.adnum=attribute.attnum
), historical_catalog AS MATERIALIZED (
  SELECT relation.exact
      AND (SELECT bool_and(exact) FROM historical_columns WHERE family='commercial')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_type definition
        WHERE definition.oid=pg_catalog.to_regtype('public."CommercialAdsSensitivity"')
          AND definition.typtype='e')
      AND ARRAY(SELECT enumlabel::text FROM pg_catalog.pg_enum
        WHERE enumtypid=pg_catalog.to_regtype('public."CommercialAdsSensitivity"')
        ORDER BY enumsortorder LIMIT 3) = ARRAY['BALANCED','STRICT']
      AND pg_catalog.to_regclass('public.chat_commercial_allowlist') IS NULL
      AND pg_catalog.to_regclass('public.chat_commercial_stoplist') IS NULL
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute attribute
        WHERE attribute.attrelid=relation.oid AND NOT attribute.attisdropped
          AND attribute.attname IN ('commercial_ads_repeat_window_sec',
            'commercial_ads_low_confidence_log_enabled','commercial_ads_warn_first_enabled'))
      AS commercial,
    relation.exact AND (SELECT bool_and(exact) FROM historical_columns WHERE family='remove_bots')
      AS remove_bots,
    relation.exact AND (SELECT bool_and(exact) FROM historical_columns WHERE family='night') AS night
  FROM historical_relation relation
), historical_compatibility AS MATERIALIZED (
  ${OUTCOME_COHORT_HISTORICAL_COMPATIBILITY.map(
    (rule) =>
      `SELECT '${rule.name}'::text AS name, COALESCE(${rule.catalog},false) AS exact FROM historical_catalog`,
  ).join('\n  UNION ALL\n  ')}
)`;

export const historicalCompatibilityProjection =
  "COALESCE((SELECT json_agg(historical_compatibility ORDER BY name) FROM historical_compatibility), '[]'::json)";
