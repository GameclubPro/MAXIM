import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  marketplaceEditorialMutationSchema,
  marketplaceEditorialRelayInputSchema,
  marketplaceEditorialStateSchema,
  marketplaceEditorialProofSchema,
} from '../src/marketplace-integration.js';
const cases = z
  .array(
    z
      .object({
        name: z.string(),
        schema: z.enum(['mutation', 'relay', 'state', 'proof']),
        accepted: z.boolean(),
        value: z.unknown(),
      })
      .strict(),
  )
  .parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/marketplace-editorial-wire.json', import.meta.url), 'utf8'),
    ),
  );
const schemas = {
  mutation: marketplaceEditorialMutationSchema,
  relay: marketplaceEditorialRelayInputSchema,
  state: marketplaceEditorialStateSchema,
  proof: marketplaceEditorialProofSchema,
};
describe('shared Market/peer editorial wire cases', () => {
  it.each(cases)('$name', ({ schema, value, accepted }) => {
    expect(schemas[schema].safeParse(value).success).toBe(accepted);
  });
});
