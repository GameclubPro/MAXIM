export const INVENTORY_STATUS_LANES = Object.freeze(['FAILED', 'QUEUED', 'RECEIVED']);
export const INVENTORY_PAGE_SIZE = 200;
export const INVENTORY_LIMITS = Object.freeze({
  maxRequestBytes: 4096,
  maxPageBytes: 2 * 1024 * 1024,
  maxMetadataBytes: 128 * 1024 * 1024,
  maxPages: 10000,
  maxRowObservations: 2000000,
  maxUniqueOwners: 100000,
  maxUniqueChats: 100000,
});
const categories = Object.freeze([
  'released_marker',
  'non_ordered',
  'unknown_payload',
  'unknown_claim',
  'unknown_metadata',
  'claim_completed_marker',
  'claim_started_unfinished',
  'claim_prepared_unstarted',
  'claim_pending_unprepared',
  'no_claim_metadata',
]);
const unknownKinds = Object.freeze([
  'payload_unavailable',
  'ordering_unknown',
  'chat_unavailable',
  'message_unavailable',
  'semantic_unavailable',
  'bot_unavailable',
  'claim_conflict',
  'claim_identity_unavailable',
  'claim_status_other',
  'claim_metadata_inconsistent',
  'lease_malformed',
  'checkpoint_unavailable',
  'error_unavailable',
  'source_validation_required',
  'remote_effects_unverified',
]);
const stopReasons = Object.freeze([
  'page_budget',
  'row_budget',
  'metadata_byte_budget',
  'owner_budget',
  'chat_budget',
]);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const requestKeys = ['version', 'inventoryId', 'sourceSha', 'imageId', 'cutoff'];
const pageKeys = [
  'version',
  'kind',
  'readOnly',
  'observedAt',
  'status',
  'cutoff',
  'pageSize',
  'after',
  'rawCount',
  'hasMore',
  'nextCursor',
  'rows',
  'coverage',
  'mutationAuthorized',
];
const rowKeys = [
  'id',
  'createdAt',
  'status',
  'normalizedBounded',
  'ordered',
  'chatId',
  'messageId',
  'semanticKey',
  'botId',
  'legacyReleased',
  'sourceReleased',
  'retry',
  'quarantine',
  'errorFamily',
  'claim',
];
const claimKeys = [
  'semanticFound',
  'directCount',
  'conflict',
  'id',
  'ownerId',
  'status',
  'enforced',
  'prepared',
  'started',
  'completed',
  'lease',
  'checkpoint',
];
const tally = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
function check(condition, code = 'order_inventory_invalid') {
  if (!condition) throw new Error(code);
}
function exactKeys(value, keys) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  check([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const own = Reflect.ownKeys(value);
  check(own.length === keys.length && own.every((key) => keys.includes(key)));
  check(
    own.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    }),
  );
}
function boundedArray(value, limit) {
  check(Array.isArray(value) && value.length <= limit);
  check(Reflect.ownKeys(value).length === value.length + 1);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
}
function parseJson(value, byteLimit) {
  if (typeof value !== 'string') return value;
  check(Buffer.byteLength(value, 'utf8') <= byteLimit);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('order_inventory_invalid_json');
  }
}
function bool(value) {
  check(typeof value === 'boolean');
}
function integer(value, max) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= max);
}
function oneOf(value, values) {
  check(values.includes(value));
}
function identifier(value, nullable = false) {
  check((nullable && value === null) || (typeof value === 'string' && idPattern.test(value)));
}
function metadataString(value, max) {
  check(
    value === null ||
      (typeof value === 'string' &&
        value.trim() === value &&
        value.length > 0 &&
        Buffer.byteLength(value, 'utf8') <= max &&
        // eslint-disable-next-line no-control-regex -- Metadata identities reject control bytes.
        !/[\u0000-\u001f\u007f]/u.test(value)),
  );
}
// FLAG: PostgreSQL cursor precision is six digits; Date alone collapses distinct rows.
function instant(value, requestPrecision = false) {
  check(
    typeof value === 'string' &&
      (requestPrecision
        ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/u
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u
      ).test(value),
  );
  const milliseconds = Date.parse(value);
  check(Number.isFinite(milliseconds));
  const prefix = new Date(milliseconds).toISOString();
  check(prefix.slice(0, 23) === value.slice(0, 23));
  return value.slice(0, 20) + value.slice(20, -1).padEnd(6, '0') + 'Z';
}
function cursor(value, cutoff) {
  if (value === null) return;
  exactKeys(value, ['createdAt', 'id']);
  identifier(value.id);
  check(instant(value.createdAt) < instant(cutoff, true));
}
function sameCursor(left, right) {
  return left === null
    ? right === null
    : right !== null && left.createdAt === right.createdAt && left.id === right.id;
}
function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function parseInventoryRequest(input) {
  const value = parseJson(input, INVENTORY_LIMITS.maxRequestBytes);
  exactKeys(value, requestKeys);
  check(value.version === 1);
  check(typeof value.inventoryId === 'string' && uuidPattern.test(value.inventoryId));
  check(typeof value.sourceSha === 'string' && /^[0-9a-f]{40}$/u.test(value.sourceSha));
  check(typeof value.imageId === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.imageId));
  instant(value.cutoff, true);
  check(Buffer.byteLength(JSON.stringify(value)) <= INVENTORY_LIMITS.maxRequestBytes);
  return freezeTree(copy(value));
}
function validateRow(row, cutoff, status) {
  exactKeys(row, rowKeys);
  identifier(row.id);
  check(instant(row.createdAt) < instant(cutoff, true));
  check(row.status === status);
  for (const key of ['normalizedBounded', 'legacyReleased', 'sourceReleased']) bool(row[key]);
  check(row.ordered === null || typeof row.ordered === 'boolean');
  metadataString(row.chatId, 128);
  metadataString(row.messageId, 1024);
  metadataString(row.semanticKey, 1024);
  metadataString(row.botId, 128);
  oneOf(row.retry, ['none', 'due', 'future']);
  oneOf(row.quarantine, ['none', 'live', 'expired']);
  oneOf(row.errorFamily, [
    'none',
    'unavailable',
    'legacy_unverified',
    'timeout_quarantine',
    'other',
  ]);
  const claim = row.claim;
  exactKeys(claim, claimKeys);
  for (const key of ['semanticFound', 'conflict', 'enforced', 'prepared', 'started', 'completed'])
    bool(claim[key]);
  integer(claim.directCount, 2);
  identifier(claim.id, true);
  identifier(claim.ownerId, true);
  oneOf(claim.status, ['missing', 'PENDING', 'READY', 'COMPLETED', 'other']);
  oneOf(claim.lease, ['missing', 'absent', 'malformed', 'live', 'expired']);
  oneOf(claim.checkpoint, [
    'missing',
    'none',
    'finished_marker',
    'waiting_marker',
    'unavailable',
    'other',
  ]);
}

export function validateInventoryPage(input, requestInput) {
  const request = parseInventoryRequest(requestInput);
  const value = parseJson(input, INVENTORY_LIMITS.maxPageBytes);
  exactKeys(value, pageKeys);
  check(
    value.version === 1 && value.kind === 'order_blocker_inventory_page' && value.readOnly === true,
  );
  check(value.coverage === 'ONLINE_PREVIEW' && value.mutationAuthorized === false);
  check(value.cutoff === request.cutoff && value.pageSize === INVENTORY_PAGE_SIZE);
  check(instant(value.observedAt) >= instant(request.cutoff, true));
  oneOf(value.status, INVENTORY_STATUS_LANES);
  cursor(value.after, request.cutoff);
  cursor(value.nextCursor, request.cutoff);
  integer(value.rawCount, INVENTORY_PAGE_SIZE + 1);
  bool(value.hasMore);
  boundedArray(value.rows, INVENTORY_PAGE_SIZE);
  check(value.hasMore === (value.rawCount === INVENTORY_PAGE_SIZE + 1));
  check(value.rows.length === Math.min(value.rawCount, INVENTORY_PAGE_SIZE));
  let previous = value.after;
  const seen = new Set(value.after === null ? [] : [value.after.id]);
  // FLAG: The separately attested SQL keyset/index owns equal-time ID ordering.
  // JavaScript string ordering cannot substitute for the database collation.
  for (const row of value.rows) {
    validateRow(row, request.cutoff, value.status);
    check(previous === null || instant(previous.createdAt) <= instant(row.createdAt));
    check(!seen.has(row.id));
    seen.add(row.id);
    previous = row;
  }
  const last = value.rows.at(-1);
  check(sameCursor(value.nextCursor, last ? { createdAt: last.createdAt, id: last.id } : null));
  check(Buffer.byteLength(JSON.stringify(value)) <= INVENTORY_LIMITS.maxPageBytes);
  return freezeTree(copy(value));
}
function inconsistentClaim(claim) {
  if (claim.directCount > 1 && !claim.conflict) return true;
  if (claim.status === 'missing')
    return (
      claim.id !== null ||
      claim.ownerId !== null ||
      claim.semanticFound ||
      claim.directCount === 1 ||
      claim.enforced ||
      claim.prepared ||
      claim.started ||
      claim.completed ||
      claim.lease !== 'missing' ||
      claim.checkpoint !== 'missing'
    );
  return (
    claim.id === null ||
    claim.ownerId === null ||
    claim.lease === 'missing' ||
    claim.checkpoint === 'missing' ||
    (!claim.semanticFound && claim.directCount !== 1) ||
    (claim.directCount > 1 && !claim.conflict) ||
    (claim.started && !claim.prepared) ||
    (claim.completed && !claim.prepared) ||
    (claim.status === 'COMPLETED' && !claim.completed) ||
    (claim.status !== 'COMPLETED' && claim.completed) ||
    (claim.status === 'READY' && !claim.prepared)
  );
}
// FLAG: Metadata labels never establish source eligibility, absent effects or cancellation authority.
export function classifyInventoryRow(row) {
  exactKeys(row, rowKeys);
  validateRow(row, '9999-12-31T23:59:59.999999Z', row.status);
  oneOf(row.status, INVENTORY_STATUS_LANES);
  const claim = row.claim;
  const unknowns = [];
  const unknown = (condition, code) => {
    if (condition) unknowns.push(code);
  };
  const released = row.legacyReleased || row.sourceReleased;
  unknown(row.ordered !== false && !released && !row.normalizedBounded, 'payload_unavailable');
  unknown(row.ordered === null, 'ordering_unknown');
  unknown(row.ordered !== false && row.chatId === null, 'chat_unavailable');
  unknown(row.ordered !== false && row.messageId === null, 'message_unavailable');
  unknown(row.ordered !== false && row.semanticKey === null, 'semantic_unavailable');
  unknown(row.botId === null, 'bot_unavailable');
  unknown(claim.conflict || claim.directCount > 1, 'claim_conflict');
  unknown(
    claim.status !== 'missing' && (claim.id === null || claim.ownerId === null),
    'claim_identity_unavailable',
  );
  unknown(claim.status === 'other', 'claim_status_other');
  unknown(inconsistentClaim(claim), 'claim_metadata_inconsistent');
  unknown(claim.lease === 'malformed', 'lease_malformed');
  unknown(claim.checkpoint === 'unavailable', 'checkpoint_unavailable');
  unknown(row.errorFamily === 'unavailable', 'error_unavailable');
  unknown(row.ordered !== false && !released, 'source_validation_required');
  unknown(row.ordered !== false && !released, 'remote_effects_unverified');
  let category;
  if (released) category = 'released_marker';
  else if (row.ordered === false) category = 'non_ordered';
  else if (!row.normalizedBounded || row.ordered === null) category = 'unknown_payload';
  else if (
    claim.conflict ||
    claim.directCount > 1 ||
    inconsistentClaim(claim) ||
    claim.status === 'other'
  )
    category = 'unknown_claim';
  else if (
    row.chatId === null ||
    row.messageId === null ||
    row.semanticKey === null ||
    row.botId === null ||
    claim.lease === 'malformed' ||
    claim.checkpoint === 'unavailable'
  )
    category = 'unknown_metadata';
  else if (claim.status === 'missing') category = 'no_claim_metadata';
  else if (claim.completed) category = 'claim_completed_marker';
  else if (claim.started) category = 'claim_started_unfinished';
  else if (claim.prepared) category = 'claim_prepared_unstarted';
  else category = 'claim_pending_unprepared';
  return freezeTree({ category, unknowns });
}

// FLAG: Three contiguous online EOFs prove only completion of this preview traversal.
// Status changes can repeat or hide observations. No frozen or fleet total is inferred.
export function createInventoryAccumulator(requestInput, options = {}) {
  check(options && typeof options === 'object' && !Array.isArray(options));
  const optionKeys = Object.keys(options);
  exactKeys(options, optionKeys);
  check(optionKeys.length === 0 || (optionKeys.length === 1 && optionKeys[0] === 'limits'));
  const limits = { ...INVENTORY_LIMITS };
  if (options.limits !== undefined) {
    check(options.limits && typeof options.limits === 'object' && !Array.isArray(options.limits));
    const keys = Object.keys(options.limits);
    exactKeys(options.limits, keys);
    for (const key of keys) {
      check(
        [
          'maxMetadataBytes',
          'maxPages',
          'maxRowObservations',
          'maxUniqueOwners',
          'maxUniqueChats',
        ].includes(key),
      );
      integer(options.limits[key], INVENTORY_LIMITS[key]);
      limits[key] = options.limits[key];
    }
  }
  const request = parseInventoryRequest(requestInput);
  const state = {
    pages: 0,
    rowObservations: 0,
    metadataBytes: 0,
    lane: 0,
    after: null,
    observedAt: null,
    stopReason: null,
    lanes: Object.fromEntries(
      INVENTORY_STATUS_LANES.map((status) => [
        status,
        { complete: false, pages: 0, rowObservations: 0 },
      ]),
    ),
    categories: tally(categories),
    unknowns: tally(unknownKinds),
    retry: tally(['none', 'due', 'future']),
    quarantine: tally(['none', 'live', 'expired']),
  };
  const owners = new Set();
  const chats = new Set();
  const complete = () => state.lane === INVENTORY_STATUS_LANES.length;
  const report = () =>
    freezeTree({
      version: 1,
      kind: 'order_blocker_inventory_report',
      readOnly: true,
      coverage: 'ONLINE_PREVIEW',
      complete: complete(),
      closedWorldComplete: false,
      mutationAuthorized: false,
      sourceEligibilityProven: false,
      remoteEffectsProven: false,
      fleetRecoveryProven: false,
      stopReason: state.stopReason,
      pages: state.pages,
      rowObservations: state.rowObservations,
      metadataBytes: state.metadataBytes,
      lanes: copy(state.lanes),
      observed: { uniqueOwners: owners.size, uniqueChats: chats.size },
      completeCounts: complete()
        ? {
            rowObservations: state.rowObservations,
            uniqueOwners: owners.size,
            uniqueChats: chats.size,
          }
        : null,
      categories: { ...state.categories },
      unknowns: { ...state.unknowns },
      retry: { ...state.retry },
      quarantine: { ...state.quarantine },
    });
  const nextRequest = () =>
    complete()
      ? null
      : freezeTree({
          ...request,
          status: INVENTORY_STATUS_LANES[state.lane],
          after: copy(state.after),
          pageSize: INVENTORY_PAGE_SIZE,
        });
  const addPage = (input) => {
    check(!complete() && state.stopReason === null, 'order_inventory_not_accepting_pages');
    const page = validateInventoryPage(input, request);
    check(
      page.status === INVENTORY_STATUS_LANES[state.lane] && sameCursor(page.after, state.after),
      'order_inventory_noncontiguous_page',
    );
    check(
      state.observedAt === null || instant(page.observedAt) >= instant(state.observedAt),
      'order_inventory_observation_reversed',
    );
    const pageOwners = new Set();
    const pageChats = new Set();
    const classifications = [];
    for (const row of page.rows) {
      classifications.push(classifyInventoryRow(row));
      if (
        !row.claim.conflict &&
        row.claim.directCount <= 1 &&
        row.claim.id !== null &&
        row.claim.ownerId !== null &&
        row.claim.status !== 'missing' &&
        !inconsistentClaim(row.claim) &&
        !owners.has(row.claim.ownerId)
      )
        pageOwners.add(row.claim.ownerId);
      if (row.chatId !== null && !chats.has(row.chatId)) pageChats.add(row.chatId);
    }
    const bytes = Buffer.byteLength(JSON.stringify(page));
    const caps = [
      [state.pages + 1 > limits.maxPages, 'page_budget'],
      [state.rowObservations + page.rows.length > limits.maxRowObservations, 'row_budget'],
      [state.metadataBytes + bytes > limits.maxMetadataBytes, 'metadata_byte_budget'],
      [owners.size + pageOwners.size > limits.maxUniqueOwners, 'owner_budget'],
      [chats.size + pageChats.size > limits.maxUniqueChats, 'chat_budget'],
    ];
    const exceeded = caps.find(([condition]) => condition);
    if (exceeded) {
      state.stopReason = exceeded[1];
      throw new Error(`order_inventory_${state.stopReason}`);
    }
    state.pages++;
    state.rowObservations += page.rows.length;
    state.metadataBytes += bytes;
    state.observedAt = page.observedAt;
    state.lanes[page.status].pages++;
    state.lanes[page.status].rowObservations += page.rows.length;
    for (const [index, row] of page.rows.entries()) {
      const classified = classifications[index];
      state.categories[classified.category]++;
      for (const kind of classified.unknowns) state.unknowns[kind]++;
      state.retry[row.retry]++;
      state.quarantine[row.quarantine]++;
    }
    for (const owner of pageOwners) owners.add(owner);
    for (const chat of pageChats) chats.add(chat);
    if (page.hasMore) state.after = copy(page.nextCursor);
    else {
      state.lanes[page.status].complete = true;
      state.lane++;
      state.after = null;
    }
    return report();
  };
  return Object.freeze({ addPage, report, nextRequest });
}

export function validateInventoryReport(value) {
  exactKeys(value, [
    'version',
    'kind',
    'readOnly',
    'coverage',
    'complete',
    'closedWorldComplete',
    'mutationAuthorized',
    'sourceEligibilityProven',
    'remoteEffectsProven',
    'fleetRecoveryProven',
    'stopReason',
    'pages',
    'rowObservations',
    'metadataBytes',
    'lanes',
    'observed',
    'completeCounts',
    'categories',
    'unknowns',
    'retry',
    'quarantine',
  ]);
  check(
    value.version === 1 &&
      value.kind === 'order_blocker_inventory_report' &&
      value.readOnly === true &&
      value.coverage === 'ONLINE_PREVIEW',
  );
  bool(value.complete);
  for (const key of [
    'closedWorldComplete',
    'mutationAuthorized',
    'sourceEligibilityProven',
    'remoteEffectsProven',
    'fleetRecoveryProven',
  ])
    check(value[key] === false);
  check(value.stopReason === null || stopReasons.includes(value.stopReason));
  check(!value.complete || value.stopReason === null);
  integer(value.pages, INVENTORY_LIMITS.maxPages);
  integer(value.rowObservations, INVENTORY_LIMITS.maxRowObservations);
  integer(value.metadataBytes, INVENTORY_LIMITS.maxMetadataBytes);
  exactKeys(value.lanes, INVENTORY_STATUS_LANES);
  let totalPages = 0;
  let totalRows = 0;
  let unfinished = false;
  for (const status of INVENTORY_STATUS_LANES) {
    const lane = value.lanes[status];
    exactKeys(lane, ['complete', 'pages', 'rowObservations']);
    bool(lane.complete);
    integer(lane.pages, INVENTORY_LIMITS.maxPages);
    integer(lane.rowObservations, INVENTORY_LIMITS.maxRowObservations);
    check(
      lane.rowObservations <= lane.pages * INVENTORY_PAGE_SIZE &&
        (!lane.complete || lane.pages > 0),
    );
    check(lane.rowObservations >= (lane.pages - (lane.complete ? 1 : 0)) * INVENTORY_PAGE_SIZE);
    check(!unfinished || (!lane.complete && lane.pages === 0));
    if (!lane.complete) unfinished = true;
    totalPages += lane.pages;
    totalRows += lane.rowObservations;
  }
  check(
    value.complete === !unfinished &&
      totalPages === value.pages &&
      totalRows === value.rowObservations,
  );
  exactKeys(value.observed, ['uniqueOwners', 'uniqueChats']);
  integer(
    value.observed.uniqueOwners,
    Math.min(value.rowObservations, INVENTORY_LIMITS.maxUniqueOwners),
  );
  integer(
    value.observed.uniqueChats,
    Math.min(value.rowObservations, INVENTORY_LIMITS.maxUniqueChats),
  );
  if (!value.complete) check(value.completeCounts === null);
  else {
    exactKeys(value.completeCounts, ['rowObservations', 'uniqueOwners', 'uniqueChats']);
    check(
      value.completeCounts.rowObservations === value.rowObservations &&
        value.completeCounts.uniqueOwners === value.observed.uniqueOwners &&
        value.completeCounts.uniqueChats === value.observed.uniqueChats,
    );
  }
  for (const [key, keys, sums] of [
    ['categories', categories, true],
    ['unknowns', unknownKinds, false],
    ['retry', ['none', 'due', 'future'], true],
    ['quarantine', ['none', 'live', 'expired'], true],
  ]) {
    exactKeys(value[key], keys);
    for (const count of Object.values(value[key])) integer(count, value.rowObservations);
    if (sums)
      check(
        Object.values(value[key]).reduce((sum, count) => sum + count, 0) === value.rowObservations,
      );
  }
  return freezeTree(copy(value));
}
