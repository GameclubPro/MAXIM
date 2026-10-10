import { spawnSync } from 'node:child_process';
import { createInventoryAuditExecutor } from './webhook-order-blocker-inventory-cli.mjs';
import { parseOrderedAnchorRequest } from './webhook-ordered-anchor-inventory.mjs';
import {
  FROZEN_ORDERED_ANCHOR_INITIAL_PAGE_SIZE,
  validateFrozenOrderedAnchorPage,
} from './webhook-frozen-ordered-anchor-inventory.mjs';
import {
  buildFrozenOrderedAnchorPageSql,
  validateFrozenOrderedAnchorPagePlan,
} from './webhook-ordered-anchor-inventory-sql.mjs';

const check = (value) => {
  if (!value) throw new Error('frozen_ordered_reader_refused');
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// FLAG: Select the source-pinned 200-row policy before SQL. Each cursor permits
// one plain EXPLAIN and one SELECT; output refusals, SQL timeouts, bad plans and
// unknown outcomes propagate immediately without retry or cursor advancement.
export function createFrozenOrderedAnchorPageReader({
  request: rawRequest,
  run = spawnSync,
  ...options
}) {
  const request = parseOrderedAnchorRequest(rawRequest);
  let outputBytes = 0;
  const execute = createInventoryAuditExecutor({
    ...options,
    run(command, args, config) {
      const result = run(command, args, config);
      check(typeof result?.stdout === 'string');
      outputBytes += Buffer.byteLength(result.stdout);
      return result;
    },
  });
  return (parameters) => {
    check(
      parameters.cutoff === request.cutoff &&
        parameters.pageSize === FROZEN_ORDERED_ANCHOR_INITIAL_PAGE_SIZE,
    );
    outputBytes = 0;
    const sql = buildFrozenOrderedAnchorPageSql(parameters);
    const plan = validateFrozenOrderedAnchorPagePlan(
      execute(`EXPLAIN (FORMAT JSON) ${sql}`, 'explain'),
      parameters,
    );
    const page = validateFrozenOrderedAnchorPage(execute(sql, 'page'), request);
    check(page.pageSize === parameters.pageSize && same(page.after, parameters.after));
    return {
      page,
      plan,
      attempts: [
        {
          pageSize: parameters.pageSize,
          rawCount: page.rawCount,
          returnedRows: page.rows.length,
          refusal: null,
          outputBytes,
          plan,
        },
      ],
      cost: {
        inventoryPages: 1,
        inventoryRows: page.rows.length,
        inventoryProbes: 2 + 4 * page.rawCount,
        inventoryBytes: outputBytes,
      },
    };
  };
}
