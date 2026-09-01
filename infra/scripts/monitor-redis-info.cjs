'use strict';

const { readFileSync } = require('node:fs');

const ALLOWED_FIELDS = [
  'used_memory',
  'used_memory_rss',
  'mem_fragmentation_ratio',
  'blocked_clients',
  'rejected_connections',
  'evicted_keys',
  'instantaneous_ops_per_sec',
  'latest_fork_usec',
  'rdb_bgsave_in_progress',
  'rdb_last_bgsave_status',
  'rdb_last_bgsave_time_sec',
  'rdb_current_bgsave_time_sec',
  'rdb_changes_since_last_save',
  'rdb_last_cow_size',
  'aof_enabled',
];
const REQUIRED_FIELDS = [
  'used_memory',
  'used_memory_rss',
  'blocked_clients',
  'rejected_connections',
  'rdb_bgsave_in_progress',
  'rdb_last_bgsave_status',
  'rdb_last_bgsave_time_sec',
  'aof_enabled',
];
const SAFE_VALUE = /^[A-Za-z0-9.+_-]{1,64}$/u;

function summarizeRedisInfo(input) {
  if (Buffer.byteLength(input, 'utf8') > 256 * 1024) {
    throw new Error('Redis INFO is oversized.');
  }
  const allowed = new Set(ALLOWED_FIELDS);
  const values = new Map();
  for (const rawLine of input.split(/\r?\n/u)) {
    const separator = rawLine.indexOf(':');
    if (separator <= 0) continue;
    const key = rawLine.slice(0, separator);
    if (!allowed.has(key)) continue;
    const value = rawLine.slice(separator + 1);
    if (values.has(key) || !SAFE_VALUE.test(value)) {
      throw new Error('Redis INFO allowlisted field is invalid.');
    }
    values.set(key, value);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!values.has(key)) throw new Error('Redis INFO is missing a required field.');
  }
  return ALLOWED_FIELDS.filter((key) => values.has(key)).map(
    (key) => `redis ${key}=${values.get(key)}`,
  );
}

function main() {
  const lines = summarizeRedisInfo(readFileSync(0, 'utf8'));
  process.stdout.write(`${lines.join('\n')}\n`);
}

module.exports = { ALLOWED_FIELDS, REQUIRED_FIELDS, summarizeRedisInfo };

if (require.main === module) {
  try {
    main();
  } catch {
    process.stderr.write('Redis INFO parsing failed closed.\n');
    process.exitCode = 1;
  }
}
