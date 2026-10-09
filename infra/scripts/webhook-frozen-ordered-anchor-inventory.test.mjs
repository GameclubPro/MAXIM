import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildOrderedAnchorPageSql,
  buildFrozenOrderedAnchorPageSql,
} from './webhook-ordered-anchor-inventory-sql.mjs';
import { validateOrderedAnchorPage } from './webhook-ordered-anchor-inventory.mjs';
import {
  validateFrozenOrderedAnchorPage,
  createFrozenOrderedAnchorAccumulator,
} from './webhook-frozen-ordered-anchor-inventory.mjs';
import { createFrozenOrderedAnchorPageReader } from './webhook-frozen-ordered-anchor-inventory-reader.mjs';

const request = {
  version: 2,
  inventoryId: '11111111-1111-4111-8111-111111111111',
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  cutoff: '2026-10-09T16:10:00.000Z',
};
const parameters = { cutoff: request.cutoff, pageSize: 200, after: null };
function row(n) {
  return {
    orderChatId: '-1',
    id: `event_${n}`,
    createdAt: `2026-10-08T00:00:00.${String(n).padStart(6, '0')}Z`,
    status: 'RECEIVED',
    normalizedBounded: true,
    ordered: true,
    chatId: '-1',
    messageId: `message_${n}`,
    semanticKey: `semantic_${n}`,
    botId: 'major',
    legacyReleased: false,
    sourceReleased: false,
    retry: 'none',
    quarantine: 'none',
    errorFamily: 'none',
    claim: {
      semanticFound: false,
      directCount: 0,
      conflict: false,
      id: null,
      ownerId: null,
      status: 'missing',
      enforced: false,
      prepared: false,
      started: false,
      completed: false,
      lease: 'missing',
      checkpoint: 'missing',
    },
  };
}
function page(input = parameters, count = 0, hasMore = false, start = 0) {
  const rows = Array.from({ length: count }, (_, index) => row(start + index + 1));
  const last = rows.at(-1);
  return {
    version: 3,
    kind: 'frozen_ordered_anchor_inventory_page',
    readOnly: true,
    observedAt: '2026-10-09T16:20:00.000000Z',
    ...input,
    rawCount: count + Number(hasMore),
    hasMore,
    nextCursor: last ? { chatId: last.orderChatId, createdAt: last.createdAt, id: last.id } : null,
    rows,
    coverage: 'STOPPED_METADATA',
    mutationAuthorized: false,
  };
}
const refused = (size = 200) => ({
  version: 3,
  kind: 'frozen_ordered_anchor_page_refused',
  reason: 'output_budget',
  readOnly: true,
  cutoff: request.cutoff,
  pageSize: size,
  after: null,
  rawCount: size + 1,
  mutationAuthorized: false,
});
function plan(size) {
  const chat = `COALESCE(NULLIF(btrim(((normalized_payload -> 'message'::text) ->> 'chatId'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'chatId'::text)), ''::text))`;
  const index = (relation, name, condition, cap) => ({
    'Node Type': 'Limit',
    'Plan Rows': cap,
    Plans: [
      {
        'Node Type': 'Index Scan',
        'Relation Name': relation,
        'Index Name': name,
        'Index Cond': condition,
      },
    ],
  });
  return [
    {
      Plan: {
        'Node Type': 'Result',
        Plans: [
          index(
            'webhook_events',
            'webhook_events_ordered_chat_head_idx',
            `${chat} IS NOT NULL AND created_at < '2026-10-09 16:10:00'::timestamp without time zone`,
            size + 1,
          ),
          index('webhook_events', 'webhook_events_pkey', 'id = p.id', 1),
          index(
            'webhook_execution_claims',
            'webhook_execution_claims_kind_semantic_key',
            "kind = 'EXECUTION' AND semantic_key = r.semantic_key",
            1,
          ),
          index(
            'webhook_execution_claims',
            'webhook_execution_claims_event_kind_idx',
            "kind = 'EXECUTION' AND webhook_event_id = r.id",
            2,
          ),
          index('webhook_execution_claims', 'webhook_execution_claims_pkey', 'id = r.chosen_id', 1),
        ],
      },
    },
  ];
}
function reader(t, answer) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-frozen-page-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const read = createFrozenOrderedAnchorPageReader({
    request,
    repositoryRoot: resolve(import.meta.dirname, '../..'),
    temporaryDirectory: directory,
    run(command, args, config) {
      assert.equal(command, 'bash');
      assert.equal(config.timeout, 14000);
      assert.equal(config.maxBuffer, 2 * 1024 * 1024);
      const source = readFileSync(args[0], 'utf8');
      assert.match(source, /statement_timeout.*2500/u);
      const body = source
        .split("cat <<'MAXIM_ORDER_INVENTORY_SQL'\n")[1]
        .split('MAXIM_ORDER_INVENTORY_SQL')[0];
      const size = body.includes("'pageSize',1000") ? 1000 : 200;
      const explain = body.includes('EXPLAIN (FORMAT JSON)');
      calls.push({ size, explain });
      const value = explain ? plan(size) : answer(size, calls);
      if (value?.failure) return value.failure;
      return {
        status: 0,
        stdout: `inventory_privileges_complete\ninventory_indexes_complete\n${JSON.stringify(value, null, 2)}\n`,
        stderr: '',
      };
    },
  });
  return { read, calls };
}

test('retained frozen1000 schema stays valid and online200 still refuses scope widening', () => {
  const historicalParameters = { ...parameters, pageSize: 1000 };
  assert.throws(() => buildOrderedAnchorPageSql(historicalParameters));
  const frozen = page(historicalParameters, 1000, true);
  validateFrozenOrderedAnchorPage(frozen, request);
  assert.throws(() => validateOrderedAnchorPage(frozen, request));
  for (const size of [0, 201, 999, 1001])
    assert.throws(() => buildFrozenOrderedAnchorPageSql({ ...parameters, pageSize: size }));
  assert.throws(() => validateFrozenOrderedAnchorPage({ ...frozen, version: 2 }, request));
  assert.throws(() => validateFrozenOrderedAnchorPage({ ...frozen, rawCount: 1002 }, request));
});

test('new walks preselect200 at every cursor and require explicit EOF', () => {
  const acc = createFrozenOrderedAnchorAccumulator(request);
  assert.equal(acc.nextRequest().pageSize, 200);
  acc.addPage(page(acc.nextRequest(), 200, true));
  assert.equal(acc.report().complete, false);
  assert.equal(acc.nextRequest().pageSize, 200);
  const next = acc.nextRequest();
  assert.equal(next.after.id, 'event_200');
  acc.addPage(page(next, 3, false, 200));
  assert.equal(acc.nextRequest(), null);
  assert.equal(acc.report().complete, true);
  assert.equal(acc.report().rowObservations, 203);
  assert.equal(acc.report().pages, 2);
  assert.equal(acc.report().mutationAuthorized, false);
});

test('successful preselected200 page has exactly two SQL calls and one charged attempt', (t) => {
  const h = reader(t, () => page(parameters, 200, true));
  const result = h.read(parameters);
  assert.deepEqual(h.calls, [
    { size: 200, explain: true },
    { size: 200, explain: false },
  ]);
  assert.equal(result.page.pageSize, 200);
  assert.equal(result.cost.inventoryPages, 1);
  assert.equal(result.cost.inventoryRows, 200);
  assert.equal(result.cost.inventoryProbes, 2 + 4 * 201);
  assert.equal(
    result.cost.inventoryBytes,
    result.attempts.reduce((sum, attempt) => sum + attempt.outputBytes, 0),
  );
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].refusal, null);
  assert(result.cost.inventoryBytes > Buffer.byteLength(JSON.stringify(result.page)));
});

test('new reader refuses caller page-size overrides before issuing SQL', (t) => {
  const h = reader(t, () => page(parameters, 200, true));
  for (const pageSize of [0, 199, 201, 1000])
    assert.throws(() => h.read({ ...parameters, pageSize }));
  assert.equal(h.calls.length, 0);
});

test('deadline, statement timeout and unknown transport outcomes never trigger retry', (t) => {
  for (const failure of [
    { status: 124, stdout: '', stderr: '' },
    { status: 1, stdout: '', stderr: 'ERROR:  canceling statement due to statement timeout' },
    { status: 1, stdout: '', stderr: 'unknown' },
  ]) {
    const h = reader(t, () => ({ failure }));
    assert.throws(() => h.read(parameters));
    assert.equal(h.calls.length, 2);
  }
});

test('output refusal, malformed refusal and changedcursor never trigger another query', (t) => {
  for (const answer of [
    () => refused(),
    () => ({ ...refused(), reason: 'timeout' }),
    () => ({ ...refused(), after: { id: 'other' } }),
    () => page({ ...parameters, after: { id: 'other' } }, 200, true),
  ]) {
    const h = reader(t, answer);
    assert.throws(() => h.read(parameters));
    assert.equal(h.calls.length, 2);
  }
});
