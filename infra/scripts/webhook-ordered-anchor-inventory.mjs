import {
  INVENTORY_LIMITS,
  parseInventoryRequest,
  classifyInventoryRow,
} from './webhook-order-blocker-inventory.mjs';

export const ORDERED_ANCHOR_PAGE_SIZE = 200;
export const ORDERED_ANCHOR_LIMITS = Object.freeze({
  maxPages: INVENTORY_LIMITS.maxPages,
  maxRowObservations: INVENTORY_LIMITS.maxRowObservations,
  maxMetadataBytes: INVENTORY_LIMITS.maxMetadataBytes,
  maxUniqueOwners: INVENTORY_LIMITS.maxUniqueOwners,
  maxUniqueChats: INVENTORY_LIMITS.maxUniqueChats,
});
const requireFact = (value) => {
  if (!value) throw new Error('ordered_inventory_refused');
};
const copy = (value) => JSON.parse(JSON.stringify(value));
const exact = (value, keys) => {
  requireFact(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length &&
      Reflect.ownKeys(value).every(
        (key) =>
          keys.includes(key) &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value') &&
          Object.getOwnPropertyDescriptor(value, key).enumerable,
      ),
  );
};
const timeKey = (value) => {
  requireFact(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 23) === value.slice(0, 23),
  );
  return value.slice(0, -1).padEnd(26, '0');
};
function cursor(value, cutoff) {
  if (value === null) return;
  exact(value, ['chatId', 'createdAt', 'id']);
  requireFact(
    typeof value.chatId === 'string' &&
      value.chatId.trim() === value.chatId &&
      value.chatId.length > 0 &&
      Buffer.byteLength(value.chatId) <= 4096 &&
      // FLAG: Cursor keys must reject embedded control bytes before SQL transport.
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/u.test(value.chatId) &&
      typeof value.id === 'string' &&
      /^[a-zA-Z0-9_-]{1,128}$/u.test(value.id) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value.createdAt) &&
      timeKey(value.createdAt) < timeKey(cutoff),
  );
}
export function parseOrderedAnchorRequest(value) {
  exact(value, ['version', 'inventoryId', 'sourceSha', 'imageId', 'cutoff']);
  requireFact(value.version === 2);
  const parsed = parseInventoryRequest({ ...value, version: 1 });
  return Object.freeze({ ...parsed, version: 2 });
}

// FLAG: This walk covers the exact ordered-head partial index for non-NULL chat
// keys. Historical terminal failures and NULL chat keys cannot block a chat.
// SQL owns collation order; an online EOF is still not a frozen cancellation proof.
export function validateOrderedAnchorPage(value, rawRequest) {
  const request = parseOrderedAnchorRequest(rawRequest);
  exact(value, [
    'version',
    'kind',
    'readOnly',
    'observedAt',
    'cutoff',
    'pageSize',
    'after',
    'rawCount',
    'hasMore',
    'nextCursor',
    'rows',
    'coverage',
    'mutationAuthorized',
  ]);
  requireFact(
    value.version === 2 &&
      value.kind === 'ordered_anchor_inventory_page' &&
      value.readOnly === true &&
      value.cutoff === request.cutoff &&
      value.pageSize === 200 &&
      value.coverage === 'ONLINE_PREVIEW' &&
      value.mutationAuthorized === false &&
      timeKey(value.observedAt) >= timeKey(request.cutoff) &&
      Number.isSafeInteger(value.rawCount) &&
      value.rawCount >= 0 &&
      value.rawCount <= 201 &&
      value.hasMore === (value.rawCount === 201) &&
      Array.isArray(value.rows) &&
      value.rows.length === Math.min(value.rawCount, 200),
  );
  cursor(value.after, request.cutoff);
  cursor(value.nextCursor, request.cutoff);
  requireFact(
    Object.getPrototypeOf(value.rows) === Array.prototype &&
      Reflect.ownKeys(value.rows).length === value.rows.length + 1,
  );
  for (let index = 0; index < value.rows.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.rows, String(index));
    requireFact(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
  let previous = value.after;
  const ids = new Set(previous ? [previous.id] : []);
  for (const item of value.rows) {
    exact(item, [
      'orderChatId',
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
    ]);
    const { orderChatId, ...row } = item;
    const next = { chatId: orderChatId, createdAt: row.createdAt, id: row.id };
    cursor(next, request.cutoff);
    classifyInventoryRow(row);
    requireFact(!ids.has(row.id));
    ids.add(row.id);
    if (previous?.chatId === next.chatId)
      requireFact(timeKey(previous.createdAt) <= timeKey(next.createdAt));
    previous = next;
  }
  const last = value.rows.at(-1);
  const next = last ? { chatId: last.orderChatId, createdAt: last.createdAt, id: last.id } : null;
  requireFact(JSON.stringify(next) === JSON.stringify(value.nextCursor));
  requireFact(Buffer.byteLength(JSON.stringify(value)) <= INVENTORY_LIMITS.maxPageBytes);
  return copy(value);
}

export function createOrderedAnchorAccumulator(rawRequest, options = {}) {
  requireFact(options && typeof options === 'object' && !Array.isArray(options));
  exact(options, Object.hasOwn(options, 'limits') ? ['limits'] : []);
  const limits = { ...ORDERED_ANCHOR_LIMITS };
  if (options.limits !== undefined) {
    requireFact(options.limits && typeof options.limits === 'object');
    const keys = Reflect.ownKeys(options.limits);
    exact(options.limits, keys);
    for (const key of keys) {
      requireFact(
        Object.hasOwn(limits, key) &&
          Number.isSafeInteger(options.limits[key]) &&
          options.limits[key] >= 0 &&
          options.limits[key] <= limits[key],
      );
      limits[key] = options.limits[key];
    }
  }
  const request = parseOrderedAnchorRequest(rawRequest);
  let after = null,
    complete = false,
    pages = 0,
    rows = 0,
    bytes = 0;
  const owners = new Set(),
    chats = new Set(),
    ids = new Set();
  const categories = Object.fromEntries(
    [
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
    ].map((key) => [key, 0]),
  );
  return {
    addPage(rawPage) {
      const page = validateOrderedAnchorPage(rawPage, request);
      const size = Buffer.byteLength(JSON.stringify(page));
      requireFact(
        !complete &&
          JSON.stringify(page.after) === JSON.stringify(after) &&
          pages < limits.maxPages &&
          rows + page.rows.length <= limits.maxRowObservations &&
          bytes + size <= limits.maxMetadataBytes,
      );
      const newOwners = new Set(),
        newChats = new Set(),
        newIds = new Set();
      const nextCategories = { ...categories };
      for (const item of page.rows) {
        requireFact(!ids.has(item.id) && !newIds.has(item.id));
        newIds.add(item.id);
        const { orderChatId, ...row } = item;
        if (!chats.has(orderChatId)) newChats.add(orderChatId);
        const classification = classifyInventoryRow(row);
        nextCategories[classification.category]++;
        if (
          classification.category === 'claim_started_unfinished' &&
          !owners.has(row.claim.ownerId)
        )
          newOwners.add(row.claim.ownerId);
      }
      requireFact(
        owners.size + newOwners.size <= limits.maxUniqueOwners &&
          chats.size + newChats.size <= limits.maxUniqueChats,
      );
      for (const key of newOwners) owners.add(key);
      for (const key of newChats) chats.add(key);
      for (const key of newIds) ids.add(key);
      Object.assign(categories, nextCategories);
      pages++;
      rows += page.rows.length;
      bytes += size;
      after = page.nextCursor;
      complete = !page.hasMore;
    },
    nextRequest: () =>
      complete ? null : { cutoff: request.cutoff, pageSize: 200, after: copy(after) },
    report: () => ({
      version: 2,
      kind: 'ordered_anchor_inventory_report',
      readOnly: true,
      coverage: 'ONLINE_PREVIEW',
      scope: 'ordered_nonnull_chat',
      complete,
      closedWorldComplete: false,
      mutationAuthorized: false,
      sourceEligibilityProven: false,
      remoteEffectsProven: false,
      fleetRecoveryProven: false,
      pages,
      rowObservations: rows,
      metadataBytes: bytes,
      uniqueChats: chats.size,
      nominatedOwners: owners.size,
      categories: { ...categories },
    }),
  };
}
