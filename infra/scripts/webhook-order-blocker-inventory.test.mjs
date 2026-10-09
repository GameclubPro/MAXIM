import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INVENTORY_LIMITS,
  INVENTORY_PAGE_SIZE,
  INVENTORY_STATUS_LANES,
  parseInventoryRequest,
  validateInventoryPage,
  classifyInventoryRow,
  createInventoryAccumulator,
  validateInventoryReport,
} from './webhook-order-blocker-inventory.mjs';

const request = Object.freeze({
  version: 1,
  inventoryId: '12345678-1234-4234-8234-123456789abc',
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  cutoff: '2026-10-09T16:10:00.000Z',
});
const timestamp = (number) => `2026-10-09T15:00:00.${String(number).padStart(6, '0')}Z`;
const clone = (value) => JSON.parse(JSON.stringify(value));
function row(number = 1, overrides = {}) {
  return {
    id: `receipt_${String(number).padStart(6, '0')}`,
    createdAt: timestamp(number),
    status: 'FAILED',
    normalizedBounded: true,
    ordered: true,
    chatId: '-private_chat',
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
function withClaim(number = 1, owner = 'canonical_owner', overrides = {}) {
  return row(number, {
    claim: {
      semanticFound: true,
      directCount: 0,
      conflict: false,
      id: 'claim_private',
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
  const status = overrides.status ?? 'FAILED';
  return {
    version: 1,
    kind: 'order_blocker_inventory_page',
    readOnly: true,
    observedAt: '2026-10-09T16:20:00.000000Z',
    status,
    cutoff: request.cutoff,
    pageSize: 200,
    after: null,
    rawCount: rows.length + (hasMore ? 1 : 0),
    hasMore,
    nextCursor: rows.length ? { createdAt: rows.at(-1).createdAt, id: rows.at(-1).id } : null,
    rows: rows.map((entry) => ({ ...entry, status })),
    coverage: 'ONLINE_PREVIEW',
    mutationAuthorized: false,
    ...overrides,
  };
}
const fullRows = (offset = 0) => Array.from({ length: 200 }, (_, index) => row(offset + index + 1));
const assertRejected = (value, code = /order_inventory_/) => assert.throws(value, code);

for (const [name, change] of [
  [
    'extra field',
    (value) => {
      value.secret = 'private';
    },
  ],
  [
    'missing field',
    (value) => {
      delete value.version;
    },
  ],
  [
    'wrong version',
    (value) => {
      value.version = 2;
    },
  ],
  [
    'receipt instead of UUID',
    (value) => {
      value.inventoryId = 'cuid_receipt';
    },
  ],
  [
    'invalid UUID variant',
    (value) => {
      value.inventoryId = '12345678-1234-4234-1234-123456789abc';
    },
  ],
  [
    'short source',
    (value) => {
      value.sourceSha = 'abcdef1';
    },
  ],
  [
    'mutable image tag',
    (value) => {
      value.imageId = 'maxim:latest';
    },
  ],
  [
    'invalid day',
    (value) => {
      value.cutoff = '2026-02-30T16:10:00.000Z';
    },
  ],
  [
    'timezone offset',
    (value) => {
      value.cutoff = '2026-10-09T19:10:00.000+03:00';
    },
  ],
  [
    'seven fractional digits',
    (value) => {
      value.cutoff = '2026-10-09T16:10:00.0000001Z';
    },
  ],
])
  test(`request rejects ${name}`, () => {
    const value = clone(request);
    change(value);
    assertRejected(() => parseInventoryRequest(value));
  });
test('request preserves exact ISO3 or ISO6 cutoff and returns independent immutable JSON', () => {
  const value = parseInventoryRequest(JSON.stringify(request));
  assert.deepEqual(value, request);
  assert.ok(Object.isFrozen(value));
  assert.equal(
    parseInventoryRequest({ ...request, cutoff: '2026-10-09T16:10:00.000001Z' }).cutoff,
    '2026-10-09T16:10:00.000001Z',
  );
  assertRejected(() => parseInventoryRequest(' '.repeat(INVENTORY_LIMITS.maxRequestBytes + 1)));
});
test('validators refuse accessors without invoking private getters', () => {
  let invoked = false;
  const value = clone(request);
  Object.defineProperty(value, 'sourceSha', {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error('secret');
    },
  });
  assertRejected(() => parseInventoryRequest(value));
  assert.equal(invoked, false);
  const valuePage = page([row()]);
  Object.defineProperty(valuePage.rows, '0', {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error('secret');
    },
  });
  assertRejected(() => validateInventoryPage(valuePage, request));
  assert.equal(invoked, false);
});

test('201 sentinel consumes only 200 and advances to last consumed cursor', () => {
  const value = validateInventoryPage(page(fullRows(), { hasMore: true }), request);
  assert.equal(value.rawCount, 201);
  assert.equal(value.rows.length, 200);
  assert.deepEqual(value.nextCursor, { createdAt: timestamp(200), id: 'receipt_000200' });
  assert.ok(Object.isFrozen(value.rows[0].claim));
});
test('200 without sentinel and zero rows are legitimate EOF pages', () => {
  assert.equal(validateInventoryPage(page(fullRows()), request).hasMore, false);
  assert.equal(validateInventoryPage(page(), request).nextCursor, null);
});
test('keeps timestamp microseconds and permits adjacent rows within one millisecond', () => {
  const value = validateInventoryPage(page([row(1), row(2)]), request);
  assert.equal(value.rows[0].createdAt, timestamp(1));
  assertRejected(() => validateInventoryPage(page([row(2), row(1)]), request));
  assertRejected(() =>
    validateInventoryPage(
      page([row(2)], { after: { createdAt: timestamp(2), id: row(2).id } }),
      request,
    ),
  );
});
test('equal timestamp trusts attested SQL collation and refuses duplicate row identity', () => {
  validateInventoryPage(page([row(1), row(2, { createdAt: timestamp(1) })]), request);
  validateInventoryPage(page([row(2), row(1, { createdAt: timestamp(2) })]), request);
  validateInventoryPage(
    page([row(1, { id: 'A' }), row(2, { id: 'a', createdAt: timestamp(1) })]),
    request,
  );
  validateInventoryPage(
    page([row(1, { id: 'a' }), row(2, { id: 'A', createdAt: timestamp(1) })]),
    request,
  );
  assertRejected(() => validateInventoryPage(page([row(1), row(1)]), request));
});
for (const [name, change] of [
  [
    'extra content key',
    (value) => {
      value.rows[0].body = 'PRIVATE_MESSAGE_BODY';
    },
  ],
  [
    'raw error key',
    (value) => {
      value.rows[0].claim.rawError = 'PRIVATE_ERROR';
    },
  ],
  [
    'oversized UTF8 metadata',
    (value) => {
      value.rows[0].chatId = 'я'.repeat(65);
    },
  ],
  [
    'control bytes',
    (value) => {
      value.rows[0].messageId = 'secret\ntext';
    },
  ],
  [
    'unknown error enum',
    (value) => {
      value.rows[0].errorFamily = 'PRIVATE_ERROR';
    },
  ],
  [
    'nullable boolean',
    (value) => {
      value.rows[0].claim.prepared = null;
    },
  ],
  [
    'invalid row ID',
    (value) => {
      value.rows[0].id = 'bad/id';
    },
  ],
  [
    'status mismatch',
    (value) => {
      value.rows[0].status = 'RECEIVED';
    },
  ],
  [
    'late row',
    (value) => {
      value.rows[0].createdAt = '2026-10-09T16:10:00.000000Z';
    },
  ],
  [
    'ISO3 row precision',
    (value) => {
      value.rows[0].createdAt = '2026-10-09T15:00:00.000Z';
    },
  ],
  [
    'early observed time',
    (value) => {
      value.observedAt = '2026-10-09T16:09:59.999999Z';
    },
  ],
  [
    'changed cutoff',
    (value) => {
      value.cutoff = '2026-10-09T16:11:00.000Z';
    },
  ],
  [
    'wrong coverage',
    (value) => {
      value.coverage = 'FROZEN';
    },
  ],
  [
    'false authority',
    (value) => {
      value.mutationAuthorized = true;
    },
  ],
  [
    'sentinel count mismatch',
    (value) => {
      value.hasMore = true;
    },
  ],
  [
    'raw row omitted',
    (value) => {
      value.rawCount = 2;
    },
  ],
  [
    'incorrect last cursor',
    (value) => {
      value.nextCursor.id = 'sentinel';
    },
  ],
  [
    'terminal cursor dropped',
    (value) => {
      value.nextCursor = null;
    },
  ],
])
  test(`page rejects ${name}`, () => {
    const value = page([row()]);
    change(value);
    assertRejected(() => validateInventoryPage(value, request));
  });
test('bounded JSON input and arrays reject excess transport output and sparse rows', () => {
  assertRejected(() =>
    validateInventoryPage(' '.repeat(INVENTORY_LIMITS.maxPageBytes + 1), request),
  );
  const value = page([row()]);
  delete value.rows[0];
  assertRejected(() => validateInventoryPage(value, request));
});

test('metadata classification preserves distinct uncertain cases without inferring eligibility', () => {
  assert.equal(classifyInventoryRow(row()).category, 'no_claim_metadata');
  assert.equal(
    classifyInventoryRow(row(1, { normalizedBounded: false, ordered: null })).category,
    'unknown_payload',
  );
  assert.equal(classifyInventoryRow(row(1, { ordered: false })).category, 'non_ordered');
  assert.equal(classifyInventoryRow(row(1, { legacyReleased: true })).category, 'released_marker');
  assert.equal(classifyInventoryRow(withClaim()).category, 'claim_started_unfinished');
  assert.equal(
    classifyInventoryRow(withClaim(1, 'owner', { started: false })).category,
    'claim_prepared_unstarted',
  );
  assert.equal(
    classifyInventoryRow(
      withClaim(1, 'owner', { status: 'PENDING', prepared: false, started: false }),
    ).category,
    'claim_pending_unprepared',
  );
  assert.equal(
    classifyInventoryRow(withClaim(1, 'owner', { status: 'COMPLETED', completed: true })).category,
    'claim_completed_marker',
  );
  for (const entry of [row(), withClaim(), row(1, { semanticKey: null })]) {
    assert.ok(classifyInventoryRow(entry).unknowns.includes('source_validation_required'));
    assert.ok(classifyInventoryRow(entry).unknowns.includes('remote_effects_unverified'));
  }
});
test('conflicting, incomplete and inconsistent claims remain explicit unknowns', () => {
  for (const overrides of [
    { conflict: true },
    { directCount: 2 },
    { ownerId: null },
    { status: 'other' },
    { prepared: false },
    { status: 'COMPLETED', completed: false },
    { status: 'COMPLETED', completed: true, prepared: false },
  ])
    assert.equal(classifyInventoryRow(withClaim(1, 'owner', overrides)).category, 'unknown_claim');
  const missingConflict = row();
  missingConflict.claim.directCount = 2;
  assert.ok(classifyInventoryRow(missingConflict).unknowns.includes('claim_metadata_inconsistent'));
  assert.ok(
    classifyInventoryRow(
      withClaim(1, 'owner', { prepared: false, started: false }),
    ).unknowns.includes('claim_metadata_inconsistent'),
  );
});
test('completed local observation need not have started business execution', () => {
  const completed = withClaim(1, 'owner', {
    status: 'COMPLETED',
    prepared: true,
    completed: true,
    started: false,
  });
  assert.equal(classifyInventoryRow(completed).category, 'claim_completed_marker');
  const inventory = createInventoryAccumulator(request);
  const report = inventory.addPage(page([completed]));
  assert.equal(report.observed.uniqueOwners, 1);
  assert.equal(report.remoteEffectsProven, false);
});
test('unavailable metadata is counted explicitly and never silently made safe', () => {
  const value = row(1, {
    normalizedBounded: false,
    ordered: null,
    chatId: null,
    messageId: null,
    semanticKey: null,
    botId: null,
    errorFamily: 'unavailable',
  });
  assert.deepEqual(classifyInventoryRow(value).unknowns, [
    'payload_unavailable',
    'ordering_unknown',
    'chat_unavailable',
    'message_unavailable',
    'semantic_unavailable',
    'bot_unavailable',
    'error_unavailable',
    'source_validation_required',
    'remote_effects_unverified',
  ]);
  assert.equal(classifyInventoryRow(row(1, { semanticKey: null })).category, 'unknown_metadata');
  assert.ok(
    classifyInventoryRow(
      withClaim(1, 'owner', { checkpoint: 'unavailable', lease: 'malformed' }),
    ).unknowns.includes('lease_malformed'),
  );
});

test('all three contiguous lanes are required for preview completion', () => {
  const inventory = createInventoryAccumulator(request);
  assert.equal(inventory.report().completeCounts, null);
  for (const [index, status] of INVENTORY_STATUS_LANES.entries()) {
    assert.equal(inventory.nextRequest().status, status);
    const report = inventory.addPage(page([], { status }));
    assert.equal(report.complete, index === 2);
    validateInventoryReport(report);
  }
  assert.equal(inventory.nextRequest(), null);
  assertRejected(() => inventory.addPage(page()));
  const report = inventory.report();
  assert.deepEqual(report.completeCounts, { rowObservations: 0, uniqueOwners: 0, uniqueChats: 0 });
  for (const field of [
    'closedWorldComplete',
    'mutationAuthorized',
    'sourceEligibilityProven',
    'remoteEffectsProven',
    'fleetRecoveryProven',
  ])
    assert.equal(report[field], false);
});
test('repeated, out-of-order, stale and changed-cursor pages do not advance inventory', () => {
  const inventory = createInventoryAccumulator(request);
  const first = page(fullRows(), { hasMore: true });
  inventory.addPage(first);
  const report = inventory.report();
  const next = inventory.nextRequest();
  for (const value of [
    first,
    page([], { status: 'RECEIVED' }),
    page([], { after: null }),
    page([], { after: next.after, observedAt: '2026-10-09T16:19:59.999999Z' }),
  ]) {
    assertRejected(() => inventory.addPage(value));
    assert.deepEqual(inventory.report(), report);
    assert.deepEqual(inventory.nextRequest(), next);
  }
  inventory.addPage(page([], { after: next.after }));
  assert.equal(inventory.nextRequest().status, 'QUEUED');
});
test('caller mutations cannot replace retained immutable cursor or request', () => {
  const localRequest = clone(request);
  const inventory = createInventoryAccumulator(localRequest);
  const first = page(fullRows(), { hasMore: true });
  inventory.addPage(first);
  const expected = inventory.nextRequest();
  first.nextCursor.id = 'changed';
  localRequest.cutoff = 'changed';
  assert.throws(() => {
    expected.after.id = 'changed';
  }, TypeError);
  assert.deepEqual(inventory.nextRequest(), expected);
});
test('mirrors and cross-lane repeats deduplicate by canonical owner, keeping observations', () => {
  const inventory = createInventoryAccumulator(request);
  inventory.addPage(page([withClaim(1), withClaim(2), withClaim(3, 'other_owner')]));
  const report = inventory.addPage(page([withClaim(1)], { status: 'QUEUED' }));
  assert.equal(report.rowObservations, 4);
  assert.equal(report.observed.uniqueOwners, 2);
  assert.equal(report.observed.uniqueChats, 1);
  assert.equal(report.completeCounts, null);
  inventory.addPage(page([], { status: 'RECEIVED' }));
  const final = validateInventoryReport(inventory.report());
  assert.equal(final.completeCounts.uniqueOwners, 2);
  assert.equal(final.completeCounts.rowObservations, 4);
  const output = JSON.stringify(final);
  for (const privateValue of [
    'receipt_',
    'canonical_owner',
    'other_owner',
    'claim_private',
    '-private_chat',
    'private_message',
    'private_semantic',
    'private_bot',
    request.inventoryId,
    request.sourceSha,
    request.imageId,
  ])
    assert.equal(output.includes(privateValue), false);
});
test('unknown or conflicting identity never creates a canonical owner', () => {
  const inventory = createInventoryAccumulator(request);
  const report = inventory.addPage(
    page([
      row(),
      withClaim(2, 'owner', { conflict: true }),
      withClaim(3, null),
      withClaim(4, 'owner', { directCount: 2 }),
    ]),
  );
  assert.equal(report.observed.uniqueOwners, 0);
  assert.equal(report.unknowns.claim_conflict, 2);
  assert.equal(report.unknowns.claim_identity_unavailable, 1);
});
for (const [name, limits, input] of [
  ['page_budget', { maxPages: 0 }, page()],
  ['row_budget', { maxRowObservations: 1 }, page([row(1), row(2)])],
  ['metadata_byte_budget', { maxMetadataBytes: 1 }, page()],
  [
    'owner_budget',
    { maxUniqueOwners: 1 },
    page([withClaim(1, 'owner_one'), withClaim(2, 'owner_two')]),
  ],
  [
    'chat_budget',
    { maxUniqueChats: 1 },
    page([row(1, { chatId: 'one' }), row(2, { chatId: 'two' })]),
  ],
])
  test(`atomic ${name} exhaustion retains cursor and incomplete counts`, () => {
    const inventory = createInventoryAccumulator(request, { limits });
    const before = inventory.report();
    const next = inventory.nextRequest();
    assertRejected(() => inventory.addPage(input), new RegExp(`order_inventory_${name}`));
    assert.deepEqual(inventory.report(), { ...before, stopReason: name });
    assert.deepEqual(inventory.nextRequest(), next);
    assert.equal(inventory.report().completeCounts, null);
    validateInventoryReport(inventory.report());
    assertRejected(() => inventory.addPage(page()), /not_accepting_pages/);
  });
test('budgets can only be reduced and mid-scan rejection retains last consumed cursor', () => {
  assertRejected(() =>
    createInventoryAccumulator(request, { limits: { maxPages: INVENTORY_LIMITS.maxPages + 1 } }),
  );
  assertRejected(() => createInventoryAccumulator(request, { limits: { arbitrary: 1 } }));
  const inventory = createInventoryAccumulator(request, { limits: { maxPages: 1 } });
  inventory.addPage(page(fullRows(), { hasMore: true }));
  const next = inventory.nextRequest();
  assertRejected(() => inventory.addPage(page([row(201)], { after: next.after })), /page_budget/);
  assert.equal(inventory.report().rowObservations, INVENTORY_PAGE_SIZE);
  assert.deepEqual(inventory.nextRequest(), next);
});
test('report validator rejects leaked identifiers, false completion and inconsistent aggregates', () => {
  const inventory = createInventoryAccumulator(request);
  inventory.addPage(page([row()]));
  const report = inventory.report();
  for (const change of [
    (value) => {
      value.secret = 'private';
    },
    (value) => {
      value.complete = true;
    },
    (value) => {
      value.completeCounts = { rowObservations: 1, uniqueOwners: 0, uniqueChats: 1 };
    },
    (value) => {
      value.remoteEffectsProven = true;
    },
    (value) => {
      value.categories.no_claim_metadata = 0;
    },
    (value) => {
      value.unknowns.remote_effects_unverified = 2;
    },
    (value) => {
      value.lanes.FAILED.pages = 100;
      value.pages = 100;
    },
    (value) => {
      value.observed.uniqueOwners = 2;
    },
  ]) {
    const value = clone(report);
    change(value);
    assertRejected(() => validateInventoryReport(value));
  }
});

test('proven nonordering or released rows need no decoded payload', () => {
  const skipped = row(1, {
    normalizedBounded: false,
    ordered: false,
    chatId: null,
    messageId: null,
  });
  const nonordering = classifyInventoryRow(skipped);
  assert.equal(nonordering.category, 'non_ordered');
  assert.equal(nonordering.unknowns.includes('payload_unavailable'), false);
  assert.equal(nonordering.unknowns.includes('source_validation_required'), false);
  const released = classifyInventoryRow({ ...skipped, ordered: null, legacyReleased: true });
  assert.equal(released.category, 'released_marker');
  assert.equal(released.unknowns.includes('payload_unavailable'), false);
});
