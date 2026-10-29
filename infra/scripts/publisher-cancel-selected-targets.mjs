import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPERATOR = 'operator:publisher-selected-target-cancellation';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = new Set(['ACTIVE', 'PAUSED', 'ERROR']);
export const CANCELLATION_CATALOG_PAGE_SQL =
  'SELECT bot_id,chat_id,entity_type,title,link FROM managed_bot_chat_catalog WHERE (bot_id,chat_id)>($1,$2) ORDER BY bot_id,chat_id LIMIT 1001';

export function normalizeCancellationRequest(input) {
  assert.equal(input.version, 1);
  assert.match(
    input.operationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.match(input.expectedRuntimeSha, /^[0-9a-f]{40}$/u);
  assert.equal(new Date(input.cutoff).toISOString(), input.cutoff);
  assert.ok(
    typeof input.reason === 'string' && input.reason.length >= 10 && input.reason.length <= 500,
  );
  assert.ok(
    Array.isArray(input.targets) && input.targets.length >= 1 && input.targets.length <= 14,
  );
  const targets = input.targets.map(({ name, link }) => {
    assert.ok(typeof name === 'string' && name.trim().length >= 1 && name.length <= 100);
    assert.match(link, /^https:\/\/max\.ru\/join\/[A-Za-z0-9_-]{20,100}$/u);
    return { name: name.trim(), link };
  });
  assert.equal(new Set(targets.map((t) => t.link)).size, targets.length);
  return {
    version: 1,
    operationId: input.operationId,
    expectedRuntimeSha: input.expectedRuntimeSha,
    cutoff: input.cutoff,
    reason: input.reason,
    targets,
  };
}

async function begin(client, readOnly) {
  await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  await client.query("SET LOCAL statement_timeout='1500ms'");
  await client.query("SET LOCAL lock_timeout='500ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='5000ms'");
  await client.query("SET LOCAL work_mem='4MB'");
  await client.query('SET LOCAL max_parallel_workers_per_gather=0');
  await client.query('SET LOCAL enable_seqscan=off');
  await client.query("SET LOCAL timezone='UTC'");
}

async function attestIndexes(client) {
  const expected = new Map([
    ['managed_bot_chat_catalog_pkey', '(bot_id, chat_id)'],
    ['publication_targets_target_type_idx', '(target_chat_id, entity_type)'],
    ['publication_targets_publication_target_key', '(publication_id, target_chat_id)'],
    ['publications_pkey', '(id)'],
    ['publication_targets_pkey', '(id)'],
    ['publication_schedules_publication_id_key', '(publication_id)'],
    ['publication_mutation_records_actor_request_key', '(actor_user_id, request_id)'],
    ['audit_logs_pkey', '(id)'],
  ]);
  const { rows } = await client.query(
    'SELECT c.relname AS indexname,pg_get_indexdef(c.oid) AS indexdef,i.indisvalid,i.indisready,i.indpred IS NULL AS unfiltered FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])',
    [[...expected.keys()]],
  );
  assert.equal(rows.length, expected.size, 'Required metadata indexes are missing');
  for (const row of rows)
    assert.ok(
      row.indisvalid &&
        row.indisready &&
        row.unfiltered &&
        row.indexdef.replaceAll('"', '').includes(expected.get(row.indexname)),
    );
}

export async function previewSelectedTargetCancellation(client, raw, publisherBotId) {
  const request = normalizeCancellationRequest(raw);
  const deadline = Date.now() + 30_000;
  const checkTime = () => assert.ok(Date.now() < deadline, 'Preview deadline exceeded');
  const matches = request.targets.map(() => new Map());
  let after = ['', ''],
    inspected = 0;
  await begin(client, true);
  try {
    await attestIndexes(client);
    // FLAG: Filter links only after a capped primary-key page. Never search the
    // entire catalog by an unindexed URL/title predicate or infer IDs from names.
    for (;;) {
      checkTime();
      const { rows } = await client.query(CANCELLATION_CATALOG_PAGE_SQL, after);
      const page = rows.slice(0, 1000);
      inspected += page.length;
      assert.ok(inspected <= 50_000, 'Catalog inventory is incomplete');
      for (const row of page)
        request.targets.forEach((target, index) => {
          if (row.link?.replace(/\/$/u, '') === target.link) matches[index].set(row.chat_id, row);
        });
      if (rows.length <= 1000) break;
      const last = page.at(-1);
      after = [last.bot_id, last.chat_id];
    }
    const groups = request.targets.map((target, index) => {
      assert.equal(
        matches[index].size,
        1,
        'An invite link is missing or maps to multiple groups: ' + target.name,
      );
      const row = [...matches[index].values()][0];
      assert.match(row.chat_id, /^-[1-9][0-9]{0,19}$/u);
      assert.equal(row.entity_type, 'CHAT');
      return { ...target, chatId: row.chat_id, botId: row.bot_id, title: row.title };
    });
    assert.equal(new Set(groups.map((g) => g.chatId)).size, groups.length, 'Duplicate group IDs');
    const parentIds = new Set();
    for (const group of groups) {
      checkTime();
      const { rows } = await client.query(
        "SELECT publication_id FROM publication_targets WHERE target_chat_id=$1 AND entity_type='CHAT' LIMIT 501",
        [group.chatId],
      );
      assert.ok(rows.length <= 500, 'Target history inventory is incomplete');
      rows.forEach((row) => parentIds.add(row.publication_id));
    }
    const { rows: parents } = await client.query(
      'SELECT id,version,lifecycle,dispatch_profile,required_bot_id,created_at FROM publications WHERE id=ANY($1::text[])',
      [[...parentIds]],
    );
    const selected = parents.filter(
      (p) =>
        p.dispatch_profile === 'PUBLIK_V1' &&
        p.required_bot_id === publisherBotId &&
        active.has(p.lifecycle) &&
        p.created_at <= new Date(request.cutoff),
    );
    assert.ok(selected.length <= 250, 'Publication selection exceeds the operator budget');
    const plans = [];
    for (const parent of selected.sort((a, b) => a.id.localeCompare(b.id))) {
      checkTime();
      const { rows } = await client.query(
        'SELECT id,target_chat_id,canceled_at FROM publication_targets WHERE publication_id=$1 LIMIT 10001',
        [parent.id],
      );
      assert.ok(rows.length <= 10_000, 'Saved audience inventory is incomplete');
      const targets = rows
        .filter((t) => t.canceled_at === null && groups.some((g) => g.chatId === t.target_chat_id))
        .map((t) => ({ id: t.id, chatId: t.target_chat_id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (targets.length)
        plans.push({ publicationId: parent.id, version: parent.version, targets });
    }
    await client.query('COMMIT');
    const preview = {
      version: 1,
      requestHash: digest(request),
      publisherBotId,
      observedAt: new Date().toISOString(),
      groups,
      plans,
    };
    return { ...preview, digest: digest(preview) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export function validateCancellationPreview(
  raw,
  preview,
  publisherBotId,
  { allowExpired = false } = {},
) {
  const request = normalizeCancellationRequest(raw);
  const { digest: savedDigest, ...body } = preview;
  assert.equal(digest(body), savedDigest, 'Preview digest changed');
  assert.equal(preview.requestHash, digest(request), 'Preview belongs to a different request');
  assert.equal(preview.publisherBotId, publisherBotId);
  const age = Date.now() - Date.parse(preview.observedAt);
  assert.ok(
    Number.isFinite(age) && age >= 0 && (allowExpired || age < 15 * 60_000),
    'Preview expired',
  );
  assert.equal(preview.groups.length, request.targets.length);
  assert.equal(new Set(preview.groups.map((g) => g.chatId)).size, preview.groups.length);
  preview.groups.forEach((group, index) => {
    assert.equal(group.link, request.targets[index].link);
    assert.equal(group.name, request.targets[index].name);
    assert.match(group.chatId, /^-[1-9][0-9]{0,19}$/u);
    assert.ok(
      typeof group.botId === 'string' && group.botId.length > 0 && group.botId.length <= 100,
    );
  });
  assert.ok(preview.plans.length <= 250);
  assert.equal(
    new Set(preview.plans.flatMap((p) => p.targets.map((t) => t.id))).size,
    preview.plans.reduce((n, p) => n + p.targets.length, 0),
  );
  assert.equal(new Set(preview.plans.map((p) => p.publicationId)).size, preview.plans.length);
  for (const plan of preview.plans) {
    assert.ok(
      typeof plan.publicationId === 'string' &&
        plan.publicationId.length > 0 &&
        plan.publicationId.length <= 100,
    );
    assert.ok(
      Number.isSafeInteger(plan.version) &&
        plan.version > 0 &&
        plan.targets.length >= 1 &&
        plan.targets.length <= 14,
    );
    assert.equal(new Set(plan.targets.map((t) => t.id)).size, plan.targets.length);
    for (const target of plan.targets) {
      assert.ok(typeof target.id === 'string' && target.id.length > 0 && target.id.length <= 100);
      assert.ok(preview.groups.some((g) => g.chatId === target.chatId));
    }
  }
  return request;
}

export async function applySelectedTargetCancellation(client, raw, preview, publisherBotId) {
  const request = validateCancellationPreview(raw, preview, publisherBotId);
  const deadline = Date.now() + 30_000;
  const outcomes = [];
  await begin(client, false);
  try {
    await attestIndexes(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))");
    for (const group of preview.groups) {
      const { rows } = await client.query(
        'SELECT link,entity_type FROM managed_bot_chat_catalog WHERE bot_id=$1 AND chat_id=$2 FOR SHARE',
        [group.botId, group.chatId],
      );
      assert.ok(
        rows.length === 1 &&
          rows[0].entity_type === 'CHAT' &&
          rows[0].link?.replace(/\/$/u, '') === group.link,
        'Invite metadata changed after preview',
      );
    }
    for (const plan of preview.plans) {
      assert.ok(Date.now() < deadline, 'Apply deadline exceeded');
      const requestId = request.operationId + ':' + plan.publicationId;
      const { rows: prior } = await client.query(
        'SELECT request_hash FROM publication_mutation_records WHERE actor_user_id=$1 AND request_id=$2',
        [OPERATOR, requestId],
      );
      if (prior.length) {
        assert.equal(prior[0].request_hash, preview.digest, 'Operation identity changed');
        outcomes.push({ publicationId: plan.publicationId, replayed: true });
        continue;
      }
      const { rows } = await client.query(
        'SELECT version,lifecycle,dispatch_profile,required_bot_id,created_at FROM publications WHERE id=$1 FOR UPDATE',
        [plan.publicationId],
      );
      const parent = rows[0];
      assert.ok(
        parent &&
          parent.version === plan.version &&
          active.has(parent.lifecycle) &&
          parent.dispatch_profile === 'PUBLIK_V1' &&
          parent.required_bot_id === publisherBotId &&
          parent.created_at <= new Date(request.cutoff),
        'Publication changed after preview',
      );
      // FLAG: Operator authority comes from the explicit reviewed invite scope.
      // No human grant is fabricated and no author account is impersonated.
      const canceled = await client.query(
        "UPDATE publication_targets SET canceled_at=CURRENT_TIMESTAMP WHERE publication_id=$1 AND id=ANY($2::text[]) AND target_chat_id=ANY($3::text[]) AND entity_type='CHAT' AND canceled_at IS NULL RETURNING id",
        [plan.publicationId, plan.targets.map((t) => t.id), plan.targets.map((t) => t.chatId)],
      );
      assert.equal(canceled.rowCount, plan.targets.length, 'Saved recipients changed');
      const updated = await client.query(
        'UPDATE publications SET version=version+1,updated_at=CURRENT_TIMESTAMP,lifecycle=CASE WHEN NOT EXISTS (SELECT 1 FROM publication_targets WHERE publication_id=$1 AND canceled_at IS NULL) THEN \'CANCELED\'::"PublicationLifecycle" ELSE lifecycle END WHERE id=$1 AND version=$2 RETURNING lifecycle',
        [plan.publicationId, plan.version],
      );
      assert.equal(updated.rowCount, 1);
      if (updated.rows[0].lifecycle === 'CANCELED')
        await client.query(
          "UPDATE publication_schedules SET status='CANCELED',next_materialize_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE publication_id=$1",
          [plan.publicationId],
        );
      await client.query(
        'INSERT INTO publication_mutation_records (id,actor_user_id,request_id,request_hash,publication_id,resulting_version) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), OPERATOR, requestId, preview.digest, plan.publicationId, plan.version + 1],
      );
      outcomes.push({ publicationId: plan.publicationId, replayed: false });
    }
    for (const group of preview.groups) {
      const auditId = 'publisher-target-cancel:' + request.operationId + ':' + group.chatId;
      const { rows } = await client.query('SELECT payload FROM audit_logs WHERE id=$1', [auditId]);
      if (rows.length)
        assert.equal(rows[0].payload.digest, preview.digest, 'Operation audit changed');
      else
        await client.query(
          'INSERT INTO audit_logs (id,chat_id,actor_user_id,action,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',
          [
            auditId,
            group.chatId,
            OPERATOR,
            'PUBLISHER_SELECTED_TARGET_CANCELLATION',
            JSON.stringify({
              operationId: request.operationId,
              digest: preview.digest,
              cutoff: request.cutoff,
              reason: request.reason,
            }),
          ],
        );
    }
    // FLAG: This stop-only operation never changes delivery/attempt/lease/receipt
    // rows, calendar reservations, queues or MAX messages. Readers enforce the marker.
    await verifySelectedTargetCancellation(client, preview);
    await client.query('COMMIT');
    return {
      applied: true,
      digest: preview.digest,
      groups: preview.groups.map((group) => ({
        name: group.name,
        chatId: group.chatId,
        canceledTargets: preview.plans.reduce(
          (n, p) => n + p.targets.filter((t) => t.chatId === group.chatId).length,
          0,
        ),
      })),
      publications: outcomes.length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function verifySelectedTargetCancellation(client, preview) {
  const ids = preview.plans.flatMap((p) => p.targets.map((t) => t.id));
  const { rows } = await client.query(
    'SELECT id,canceled_at FROM publication_targets WHERE id=ANY($1::text[])',
    [ids],
  );
  assert.equal(rows.length, ids.length, 'A reviewed target disappeared');
  assert.ok(
    rows.every((row) => row.canceled_at !== null),
    'A reviewed target is still active',
  );
  return { verifiedTargets: rows.length };
}

export async function runCancellationContainer(request, preview, verify = false) {
  assert.equal(process.env.APP_SERVICE_NAME, 'api-publisher');
  assert.equal(process.env.APP_ROLE, 'publisher');
  process.env.TZ = 'UTC';
  const require = createRequire(resolve('operator.cjs'));
  const { Client } = require('pg');
  const { buildPublisherBotDescriptor } = require(
    resolve('apps/api/dist/apps/api/src/publisher/publisher-bot-descriptor.js'),
  );
  const publisherBotId = buildPublisherBotDescriptor({ id: process.env.MAX_PUBLISHER_BOT_ID }).id;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'publisher-selected-target-cancel',
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  await client.connect();
  try {
    if (verify) {
      validateCancellationPreview(request, preview, publisherBotId, { allowExpired: true });
      await begin(client, true);
      try {
        await attestIndexes(client);
        const result = await verifySelectedTargetCancellation(client, preview);
        for (const plan of preview.plans) {
          const { rows } = await client.query(
            'SELECT request_hash FROM publication_mutation_records WHERE actor_user_id=$1 AND request_id=$2',
            [OPERATOR, request.operationId + ':' + plan.publicationId],
          );
          assert.equal(
            rows[0]?.request_hash,
            preview.digest,
            'Committed operation record is missing',
          );
        }
        await client.query('COMMIT');
        console.log(JSON.stringify({ ...result, digest: preview.digest }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } else {
      console.log(
        JSON.stringify(
          preview
            ? await applySelectedTargetCancellation(client, request, preview, publisherBotId)
            : await previewSelectedTargetCancellation(client, request, publisherBotId),
        ),
      );
    }
  } finally {
    await client.end();
  }
}

export function selectedTargetCancellationRunner(request, preview = null, verify = false) {
  normalizeCancellationRequest(request);
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  return (
    source +
    '\nawait runCancellationContainer(' +
    JSON.stringify(request) +
    ',' +
    JSON.stringify(preview) +
    ',' +
    JSON.stringify(verify) +
    ').catch((error) => { process.stderr.write(JSON.stringify({code:"selected_target_cancellation_refused", detail:error instanceof assert.AssertionError ? error.message.slice(0,250) : "Database operation failed; acknowledgement may be unknown"})+"\\n"); process.exitCode=1; });\n'
  );
}

export function readPrivateCancellationJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        stat.size <= 256 * 1024 &&
        (stat.mode & 0o777) === 0o600,
    );
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    assert.ok(
      ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].every(
        (key) => stat[key] === after[key],
      ),
    );
    return JSON.parse(raw);
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv[2] === '--emit-runner' && [4, 6].includes(process.argv.length));
    assert.ok(process.argv.length === 4 || process.argv[4] === '--apply');
    process.stdout.write(
      selectedTargetCancellationRunner(
        readPrivateCancellationJson(process.argv[3]),
        process.argv[5] ? readPrivateCancellationJson(process.argv[5]) : null,
      ),
    );
  } catch {
    process.stderr.write(
      'Use --emit-runner <private-0600-request.json> [--apply <private-0600-preview.json>].\n',
    );
    process.exitCode = 2;
  }
}
