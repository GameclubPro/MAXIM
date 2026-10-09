import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORDERED_ANCHOR_PAGE_SIZE,
  ORDERED_ANCHOR_LIMITS,
  parseOrderedAnchorRequest,
  validateOrderedAnchorPage,
  createOrderedAnchorAccumulator,
} from './webhook-ordered-anchor-inventory.mjs';

const request = Object.freeze({
  version: 2,
  inventoryId: '12345678-1234-4234-8234-123456789abc',
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  cutoff: '2026-10-09T16:10:00.000Z',
});
const timestamp = (number) => `2026-10-09T15:00:00.${String(number).padStart(6, '0')}Z`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const rowCursor = (row) => ({ chatId: row.orderChatId, createdAt: row.createdAt, id: row.id });
const rejected = (fn) => assert.throws(fn, /(?:ordered|order)_inventory_/);

function row(number = 1, overrides = {}) {
  return {
    orderChatId: '-private_actual_chat',
    id: `private_receipt_${String(number).padStart(6, '0')}`,
    createdAt: timestamp(number),
    status: 'FAILED',
    normalizedBounded: true,
    ordered: true,
    chatId: '-private_payload_chat',
    messageId: 'private_message',
    semanticKey: 'private_semantic',
    botId: 'private_bot',
    legacyReleased: false,
    sourceReleased: false,
    retry: 'due',
    quarantine: 'expired',
    errorFamily: 'legacy_unverified',
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
    ...overrides,
  };
}
function withClaim(number, owner = 'private_canonical_owner', overrides = {}) {
  return row(number, {
    claim: {
      semanticFound: true,
      directCount: 0,
      conflict: false,
      id: 'private_claim',
      ownerId: owner,
      status: 'READY',
      enforced: true,
      prepared: true,
      started: true,
      completed: false,
      lease: 'expired',
      checkpoint: 'waiting_marker',
      ...overrides,
    },
  });
}
function page(rows = [], overrides = {}) {
  const hasMore = overrides.hasMore ?? false;
  return {
    version: 2,
    kind: 'ordered_anchor_inventory_page',
    readOnly: true,
    observedAt: '2026-10-09T16:20:00.000000Z',
    cutoff: request.cutoff,
    pageSize: ORDERED_ANCHOR_PAGE_SIZE,
    after: null,
    rawCount: rows.length + (hasMore ? 1 : 0),
    hasMore,
    nextCursor: rows.length ? rowCursor(rows.at(-1)) : null,
    rows,
    coverage: 'ONLINE_PREVIEW',
    mutationAuthorized: false,
    ...overrides,
  };
}
const fullRows = (offset = 0) => Array.from({ length: 200 }, (_, index) => row(offset + index + 1));

test('request preserves pinned identity and exact ISO3 or ISO6 cutoff', () => {
  const parsed = parseOrderedAnchorRequest(request);
  assert.deepEqual(parsed, request);
  assert.notEqual(parsed, request);
  assert.ok(Object.isFrozen(parsed));
  const precise = { ...request, cutoff: '2026-10-09T16:10:00.000001Z' };
  assert.equal(parseOrderedAnchorRequest(precise).cutoff, precise.cutoff);
  for (const overrides of [
    { version: 1 },
    { sourceSha: 'latest' },
    { imageId: 'maxim:latest' },
    { cutoff: '2026-02-30T16:10:00.000Z' },
    { cutoff: '2026-10-09T16:10:00.0000001Z' },
    { privateToken: 'secret' },
  ])
    rejected(() => parseOrderedAnchorRequest({ ...request, ...overrides }));
});

test('empty online EOF completes only preview, never source exclusion or fleet recovery', () => {
  const accumulator = createOrderedAnchorAccumulator(request);
  assert.equal(accumulator.report().complete, false);
  assert.deepEqual(accumulator.nextRequest(), {
    cutoff: request.cutoff,
    pageSize: 200,
    after: null,
  });
  accumulator.addPage(page());
  const report = accumulator.report();
  assert.equal(report.complete, true);
  assert.equal(report.pages, 1);
  assert.equal(report.rowObservations, 0);
  assert.equal(report.scope, 'ordered_nonnull_chat');
  assert.equal(report.coverage, 'ONLINE_PREVIEW');
  for (const key of [
    'closedWorldComplete',
    'mutationAuthorized',
    'sourceEligibilityProven',
    'remoteEffectsProven',
    'fleetRecoveryProven',
  ])
    assert.equal(report[key], false, key);
  assert.equal(accumulator.nextRequest(), null);
  rejected(() => accumulator.addPage(page()));
  assert.deepEqual(accumulator.report(), report);
});

test('one contiguous mixed-status walk retains every anchor and consumes no sentinel', () => {
  const first = page(fullRows(), { hasMore: true });
  first.rows[0].status = 'RECEIVED';
  first.rows[1].status = 'QUEUED';
  const accumulator = createOrderedAnchorAccumulator(request);
  accumulator.addPage(first);
  assert.equal(accumulator.report().complete, false);
  assert.equal(accumulator.report().rowObservations, 200);
  assert.deepEqual(accumulator.nextRequest().after, rowCursor(first.rows.at(-1)));
  const final = page([row(201), row(202)], { after: first.nextCursor });
  accumulator.addPage(final);
  assert.equal(accumulator.report().complete, true);
  assert.equal(accumulator.report().rowObservations, 202);
  assert.equal(
    accumulator.report().metadataBytes,
    Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(final)),
  );
});

test('a full last page is EOF only with rawCount 200 and hasMore false', () => {
  const accumulator = createOrderedAnchorAccumulator(request);
  accumulator.addPage(page(fullRows()));
  assert.equal(accumulator.report().complete, true);
  assert.equal(accumulator.report().rowObservations, 200);
});

test('cursor uses actual database chat key and retains all six fractional digits', () => {
  const rows = [row(1), row(2)];
  const validated = validateOrderedAnchorPage(page(rows), request);
  assert.equal(validated.nextCursor.chatId, '-private_actual_chat');
  assert.equal(validated.nextCursor.createdAt, timestamp(2));
  assert.equal(new Date(rows[0].createdAt).valueOf(), new Date(rows[1].createdAt).valueOf());
  rejected(() => validateOrderedAnchorPage(page([...rows].reverse()), request));
  rejected(() => validateOrderedAnchorPage(page([row(1)], { after: rowCursor(row(2)) }), request));
});

test('fixed cutoff is exclusive even within the same millisecond', () => {
  const precise = { ...request, cutoff: '2026-10-09T16:10:00.000002Z' };
  validateOrderedAnchorPage(
    page([row(1, { createdAt: '2026-10-09T16:10:00.000001Z' })], { cutoff: precise.cutoff }),
    precise,
  );
  for (const createdAt of [precise.cutoff, '2026-10-09T16:10:00.000003Z'])
    rejected(() =>
      validateOrderedAnchorPage(page([row(1, { createdAt })], { cutoff: precise.cutoff }), precise),
    );
});

test('SQL owns chat and tied-ID collation; JavaScript lexical order is not imposed', () => {
  const tied = [row(1, { id: 'z_id' }), row(1, { id: 'A_id' })];
  validateOrderedAnchorPage(page(tied), request);
  validateOrderedAnchorPage(
    page([row(3, { orderChatId: 'z_chat' }), row(1, { orderChatId: 'A_chat' })]),
    request,
  );
});

for (const [name, overrides] of [
  ['mutable coverage', { coverage: 'FROZEN' }],
  ['mutation authority', { mutationAuthorized: true }],
  ['moving cutoff', { cutoff: '2026-10-09T16:11:00.000Z' }],
  ['observation before cutoff', { observedAt: '2026-10-09T16:09:59.999999Z' }],
  ['oversized raw page', { rawCount: 202 }],
  ['false EOF with sentinel', { rawCount: 201, hasMore: false }],
  ['false continuation', { rawCount: 1, hasMore: true }],
  ['missing output row', { rawCount: 2 }],
  ['unexpected private field', { privateToken: 'secret' }],
])
  test(`page refuses ${name}`, () =>
    rejected(() => validateOrderedAnchorPage(page([row(1)], overrides), request)));

test('actual cursor refuses null, whitespace, control characters and overlong chat keys', () => {
  for (const orderChatId of [null, '', ' chat', 'chat\nsecret', 'x'.repeat(4097)])
    rejected(() => validateOrderedAnchorPage(page([row(1, { orderChatId })]), request));
  rejected(() =>
    validateOrderedAnchorPage(
      page([row(1)], {
        nextCursor: { ...rowCursor(row(1)), createdAt: '2026-10-09T15:00:00.000Z' },
      }),
      request,
    ),
  );
});

test('row classification retains incomplete metadata and never nominates ambiguous owners', () => {
  const rows = [
    withClaim(1),
    withClaim(2),
    withClaim(3, 'private_other_owner'),
    withClaim(4, 'private_conflicted_owner', { conflict: true }),
    withClaim(5, 'private_completed_owner', {
      status: 'COMPLETED',
      completed: true,
      started: false,
    }),
    row(6, { normalizedBounded: false, ordered: null, chatId: null }),
    row(7, { orderChatId: '-private_second_actual_chat', chatId: null }),
  ];
  const accumulator = createOrderedAnchorAccumulator(request);
  accumulator.addPage(page(rows));
  const report = accumulator.report();
  assert.equal(report.nominatedOwners, 2);
  assert.equal(report.uniqueChats, 2);
  assert.equal(report.categories.claim_started_unfinished, 3);
  assert.equal(report.categories.unknown_claim, 1);
  assert.equal(report.categories.claim_completed_marker, 1);
  assert.equal(report.categories.unknown_payload, 1);
  assert.equal(report.categories.unknown_metadata, 1);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private_|12345678|sha256:/);
  assert.equal(
    Object.values(report.categories).reduce((sum, value) => sum + value, 0),
    rows.length,
  );
});

test('online metadata observations cannot turn preview EOF into absence of ordered blockers', () => {
  const accumulator = createOrderedAnchorAccumulator(request);
  accumulator.addPage(
    page([
      row(1, { ordered: false }),
      row(2, { legacyReleased: true }),
      row(3, { sourceReleased: true }),
    ]),
  );
  const report = accumulator.report();
  assert.equal(report.complete, true);
  assert.equal(report.rowObservations, 3);
  assert.equal(report.categories.non_ordered, 1);
  assert.equal(report.categories.released_marker, 2);
  assert.equal(report.nominatedOwners, 0);
  assert.equal(report.closedWorldComplete, false);
  assert.equal(report.sourceEligibilityProven, false);
  assert.equal(report.fleetRecoveryProven, false);
});

test('duplicate rows and wrong continuation fail atomically without consuming the page', () => {
  const accumulator = createOrderedAnchorAccumulator(request);
  const first = page(fullRows(), { hasMore: true });
  accumulator.addPage(first);
  const before = accumulator.report();
  const next = accumulator.nextRequest();
  for (const invalid of [
    page([row(201)]),
    page([row(1, { createdAt: timestamp(201) })], { after: first.nextCursor }),
    page([row(201), row(201)], { after: first.nextCursor }),
  ]) {
    rejected(() => accumulator.addPage(invalid));
    assert.deepEqual(accumulator.report(), before);
    assert.deepEqual(accumulator.nextRequest(), next);
  }
  accumulator.addPage(page([row(201)], { after: first.nextCursor }));
  assert.equal(accumulator.report().complete, true);
});

test('copied output and request cursors cannot mutate retained counts or traversal state', () => {
  const accumulator = createOrderedAnchorAccumulator(request);
  const first = page(fullRows(), { hasMore: true });
  const saved = clone(first);
  accumulator.addPage(first);
  first.rows[0].id = 'changed_private';
  const report = accumulator.report();
  report.categories.no_claim_metadata = 0;
  const next = accumulator.nextRequest();
  next.after.id = 'changed_cursor';
  assert.equal(accumulator.report().categories.no_claim_metadata, 200);
  assert.deepEqual(accumulator.nextRequest().after, saved.nextCursor);
});

test('private accessors are refused without being invoked at any accepted input boundary', () => {
  for (const location of ['request', 'page', 'cursor', 'row', 'claim', 'array']) {
    let invoked = false;
    const input = location === 'request' ? clone(request) : page([row(1)]);
    const [object, key] = {
      request: [input, 'sourceSha'],
      page: [input, 'observedAt'],
      cursor: [input.nextCursor, 'chatId'],
      row: [input.rows?.[0], 'orderChatId'],
      claim: [input.rows?.[0].claim, 'ownerId'],
      array: [input.rows, '0'],
    }[location];
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('private_getter_must_not_run');
      },
    });
    rejected(() =>
      location === 'request'
        ? parseOrderedAnchorRequest(input)
        : validateOrderedAnchorPage(input, request),
    );
    assert.equal(invoked, false, location);
  }
});

test('row and array shape cannot hide metadata in symbols, prototypes or sparse slots', () => {
  const inputs = [page([row(1)]), page([row(1)]), page([row(1)]), page([row(1)])];
  inputs[0].rows[0][Symbol('private')] = 'hidden';
  Object.setPrototypeOf(inputs[1].rows[0], { private: 'hidden' });
  delete inputs[2].rows[0];
  Object.defineProperty(inputs[3].rows[0], 'id', { enumerable: false });
  for (const input of inputs) rejected(() => validateOrderedAnchorPage(input, request));
});

test('all configurable limits only lower checked-in aggregate ceilings', () => {
  for (const [name, cap] of Object.entries(ORDERED_ANCHOR_LIMITS)) {
    createOrderedAnchorAccumulator(request, { limits: { [name]: cap } });
    for (const invalid of [cap + 1, -1, 1.5, '1', Infinity])
      rejected(() => createOrderedAnchorAccumulator(request, { limits: { [name]: invalid } }));
  }
  for (const invalid of [null, [], { other: 1 }, { limits: { maxPageBytes: 1 } }])
    rejected(() => createOrderedAnchorAccumulator(request, invalid));
});

for (const [name, limits, input] of [
  ['page', { maxPages: 0 }, page()],
  ['row', { maxRowObservations: 0 }, page([row(1)])],
  [
    'byte',
    { maxMetadataBytes: Buffer.byteLength(JSON.stringify(page([row(1)]))) - 1 },
    page([row(1)]),
  ],
  ['owner', { maxUniqueOwners: 0 }, page([withClaim(1)])],
  ['chat', { maxUniqueChats: 0 }, page([row(1)])],
])
  test(`${name} budget refusal preserves all counts and the pending cursor atomically`, () => {
    const accumulator = createOrderedAnchorAccumulator(request, { limits });
    const before = accumulator.report();
    const next = accumulator.nextRequest();
    rejected(() => accumulator.addPage(input));
    assert.deepEqual(accumulator.report(), before);
    assert.deepEqual(accumulator.nextRequest(), next);
    assert.equal(accumulator.report().complete, false);
  });

test('exact aggregate boundaries pass and later over-budget EOF cannot complete the walk', () => {
  const input = page([withClaim(1)]);
  const accumulator = createOrderedAnchorAccumulator(request, {
    limits: {
      maxPages: 1,
      maxRowObservations: 1,
      maxMetadataBytes: Buffer.byteLength(JSON.stringify(input)),
      maxUniqueOwners: 1,
      maxUniqueChats: 1,
    },
  });
  accumulator.addPage(input);
  assert.equal(accumulator.report().complete, true);

  const continuing = createOrderedAnchorAccumulator(request, { limits: { maxPages: 1 } });
  const first = page(fullRows(), { hasMore: true });
  continuing.addPage(first);
  const before = continuing.report();
  rejected(() => continuing.addPage(page([], { after: first.nextCursor })));
  assert.deepEqual(continuing.report(), before);
  assert.equal(continuing.report().complete, false);
});
