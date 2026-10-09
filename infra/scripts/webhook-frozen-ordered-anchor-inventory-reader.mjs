import { spawnSync } from 'node:child_process';
import { createInventoryAuditExecutor } from './webhook-order-blocker-inventory-cli.mjs';
import { parseOrderedAnchorRequest } from './webhook-ordered-anchor-inventory.mjs';
import { validateFrozenOrderedAnchorPage } from './webhook-frozen-ordered-anchor-inventory.mjs';
import {
  buildFrozenOrderedAnchorPageSql,
  validateFrozenOrderedAnchorPagePlan,
  FROZEN_ORDERED_ANCHOR_OUTPUT_BYTES,
} from './webhook-ordered-anchor-inventory-sql.mjs';

const check = (value) => {
  if (!value) throw new Error('frozen_ordered_reader_refused');
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// FLAG: Only an explicit bounded-output refusal permits one smaller SELECT at
// the same cursor. SQL timeouts, bad plans, transport errors and unknown outcomes
// propagate immediately. Both attempts consume the frozen inventory's budgets.
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
    check(parameters.cutoff === request.cutoff && parameters.pageSize === 1000);
    const attempts = [],
      cost = { inventoryPages: 0, inventoryRows: 0, inventoryProbes: 0, inventoryBytes: 0 };
    let current = parameters;
    for (;;) {
      outputBytes = 0;
      const sql = buildFrozenOrderedAnchorPageSql(current);
      const plan = validateFrozenOrderedAnchorPagePlan(
        execute(`EXPLAIN (FORMAT JSON) ${sql}`, 'explain'),
        current,
      );
      const result = execute(sql, 'page');
      let page;
      if (result?.kind === 'frozen_ordered_anchor_page_refused') {
        check(
          Object.keys(result).sort().join(',') ===
            'after,cutoff,kind,mutationAuthorized,pageSize,rawCount,readOnly,reason,version' &&
            result.version === 3 &&
            result.reason === 'output_budget' &&
            result.readOnly === true &&
            result.mutationAuthorized === false &&
            result.cutoff === request.cutoff &&
            result.pageSize === current.pageSize &&
            same(result.after, current.after) &&
            Number.isSafeInteger(result.rawCount) &&
            result.rawCount >= 0 &&
            result.rawCount <= current.pageSize + 1 &&
            Buffer.byteLength(JSON.stringify(result)) <= FROZEN_ORDERED_ANCHOR_OUTPUT_BYTES,
        );
      } else {
        page = validateFrozenOrderedAnchorPage(result, request);
        check(page.pageSize === current.pageSize && same(page.after, current.after));
      }
      cost.inventoryPages++;
      cost.inventoryRows += Math.min(result.rawCount, current.pageSize);
      cost.inventoryProbes += 2 + 4 * result.rawCount;
      cost.inventoryBytes += outputBytes;
      attempts.push({
        pageSize: current.pageSize,
        rawCount: result.rawCount,
        returnedRows: page?.rows.length ?? 0,
        refusal: page ? null : 'output_budget',
        outputBytes,
        plan,
      });
      if (page) return { page, plan, attempts, cost };
      check(current.pageSize === 1000 && attempts.length === 1);
      current = { ...parameters, pageSize: 200 };
    }
  };
}
