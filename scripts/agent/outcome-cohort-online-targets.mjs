import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const GiB = 1024 ** 3;
export const OUTCOME_COHORT_TARGETS = Object.freeze([
  Object.freeze({
    selector: 'delete',
    migration: '20261017010000_index_delete_outcome_cohorts',
    checksum: 'c7e7dfd3f31d3ca4675cf7c5f322a4343dc3ce4951688b905a0d3c277f9de76b',
    table: 'moderation_delete_intents',
    index: 'moderation_delete_intents_status_created_id_idx',
    keys: Object.freeze(['status', 'created_at', 'id']),
    comparableIndex: 'moderation_delete_intents_retention_idx',
    comparableKeys: Object.freeze(['status', 'updated_at']),
    tableCeilingBytes: 4 * GiB,
    tempBytes: 2 * GiB,
    statementMs: 1_800_000,
    estimateBytesPerRow: 192,
  }),
  Object.freeze({
    selector: 'recipient',
    migration: '20261017010100_index_publication_delivery_cohorts',
    checksum: '4d2816562cfca8e947f36b01796caa42f518927761d4ed9a48289a89203c9e27',
    table: 'managed_broadcast_deliveries',
    index: 'managed_broadcast_deliveries_dispatch_status_created_id_idx',
    keys: Object.freeze(['dispatch_profile', 'status', 'created_at', 'id']),
    comparableIndex: 'managed_broadcast_deliveries_dispatch_status_locked_idx',
    comparableKeys: Object.freeze(['dispatch_profile', 'status', 'locked_at']),
    tableCeilingBytes: GiB / 2,
    tempBytes: GiB / 2,
    statementMs: 600_000,
    estimateBytesPerRow: 192,
  }),
]);

export function requireOutcomeCohortTarget(selector) {
  const target = OUTCOME_COHORT_TARGETS.find((candidate) => candidate.selector === selector);
  if (!target) throw new Error('OUTCOME_COHORT_TARGET_INVALID');
  return target;
}

export function readOutcomeCohortSource(root) {
  const directory = resolve(root, 'apps/api/prisma/migrations');
  const entries = readdirSync(directory, { withFileTypes: true });
  const source = entries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => {
      if (!/^\d{14}_[a-z0-9_]+$/u.test(name)) throw new Error('OUTCOME_COHORT_SOURCE_INVALID');
      return {
        name,
        checksum: createHash('sha256')
          .update(readFileSync(resolve(directory, name, 'migration.sql')))
          .digest('hex'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!source.length || source.length > 4032) throw new Error('OUTCOME_COHORT_SOURCE_INVALID');
  for (const target of OUTCOME_COHORT_TARGETS)
    if (source.find(({ name }) => name === target.migration)?.checksum !== target.checksum)
      throw new Error('OUTCOME_COHORT_SOURCE_CHECKSUM_MISMATCH');
  return source;
}
