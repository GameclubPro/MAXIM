-- FLAG: Certificate identities must never cascade changes into held evidence.
-- This bounded catalog assertion aligns the explicit Prisma relation with the
-- existing immutable DDL; it performs no application-data or schema mutation.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $$
DECLARE
  held_table TEXT;
BEGIN
  FOREACH held_table IN ARRAY ARRAY[
    'webhook_legacy_recoveries', 'webhook_legacy_child_holds'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint constraint_row
      WHERE constraint_row.conrelid = ('public.' || held_table)::regclass
        AND constraint_row.conname = held_table || '_certificate_id_fkey'
        AND constraint_row.contype = 'f'
        AND constraint_row.confrelid = 'public.webhook_legacy_quiescence_certificates'::regclass
        AND constraint_row.confupdtype = 'a'
        AND constraint_row.confdeltype = 'r'
        AND constraint_row.confmatchtype = 's'
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
        AND constraint_row.conkey = ARRAY[(
          SELECT attribute_row.attnum
          FROM pg_catalog.pg_attribute attribute_row
          WHERE attribute_row.attrelid = constraint_row.conrelid
            AND attribute_row.attname = 'certificate_id'
            AND NOT attribute_row.attisdropped
        )]::smallint[]
        AND constraint_row.confkey = ARRAY[(
          SELECT attribute_row.attnum
          FROM pg_catalog.pg_attribute attribute_row
          WHERE attribute_row.attrelid = constraint_row.confrelid
            AND attribute_row.attname = 'id'
            AND NOT attribute_row.attisdropped
        )]::smallint[]
    ) THEN
      RAISE EXCEPTION 'Legacy certificate identity constraint differs from reviewed definition';
    END IF;
  END LOOP;
END $$;

COMMIT;
