'use strict';
const { createRequire } = require('node:module');
const { Client } = createRequire('/app/apps/api/package.json')('pg');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// FLAG: This fixed read-only primary-key probe cannot install or alter a hold.
// No inventory, SQL text, table name, connection override or MAX credential is input.
async function main() {
  let input = '';
  const timeout = setTimeout(() => process.exit(1), 12_000);
  let client;
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 4096) throw new Error('request_budget');
    }
    const request = JSON.parse(input);
    if (
      !request ||
      Object.keys(request).sort().join(',') !== 'certificateId,version' ||
      request.version !== 1 ||
      !uuid.test(request.certificateId ?? '') ||
      !/^[0-9a-f]{40}$/u.test(process.env.APP_SOURCE_SHA ?? '') ||
      !/^sha256:[0-9a-f]{64}$/u.test(process.env.MAXIM_SOURCE_ABANDONMENT_IMAGE_ID ?? '')
    )
      throw new Error('request_unproved');
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      application_name: `maxim_abort_absence_${request.certificateId}`,
      connectionTimeoutMillis: 3000,
      query_timeout: 6000,
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0',
    });
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const statement = 'SELECT id FROM webhook_source_abandonment_certificates WHERE id = $1';
    const plan = await client.query(`EXPLAIN (FORMAT JSON) ${statement}`, [request.certificateId]);
    const node = plan.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
    if (
      !['Index Scan', 'Index Only Scan'].includes(node?.['Node Type']) ||
      node?.['Index Name'] !== 'webhook_source_abandonment_certificates_pkey' ||
      node?.Filter ||
      node?.Plans ||
      !/\bid\s*=/u.test(node?.['Index Cond'] ?? '')
    )
      throw new Error('primary_key_plan_unproved');
    const result = await client.query(statement, [request.certificateId]);
    await client.query('ROLLBACK');
    if (result.rows.length !== 0) throw new Error('certificate_not_absent');
    await client.end();
    client = null;
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        state: 'ABSENT',
        certificateId: request.certificateId,
        sourceSha: process.env.APP_SOURCE_SHA,
        imageId: process.env.MAXIM_SOURCE_ABANDONMENT_IMAGE_ID,
        readOnly: true,
      })}\n`,
    );
  } finally {
    if (client) await client.end().catch(() => {});
    clearTimeout(timeout);
  }
}
main().catch(() => {
  process.stderr.write('Certificate absence unproved.\n');
  process.exitCode = 1;
});
