import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalKaravanMarketplaceJson,
  karavanMarketplaceActorAccessResponseSchema,
  karavanMarketplaceAuthorityEvidenceSchema,
  karavanMarketplaceAuthorityRequestSchema,
} from '../src/karavan-marketplace.js';
import { marketplaceManagementRequestSchema } from '../src/karavan-marketplace-management.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/major-karavan-wire.json', import.meta.url), 'utf8'),
);
const schemas: Record<string, { safeParse(input: unknown): { success: boolean } }> = {
  authority: karavanMarketplaceAuthorityEvidenceSchema,
  access: karavanMarketplaceActorAccessResponseSchema,
  management: marketplaceManagementRequestSchema,
};
const inputs: Record<string, object> = {
  authority: fixture.authorityEvidence,
  access: fixture.accessDenied,
  management: fixture.management,
};

describe('shared Major and Karavan wire fixtures', () => {
  it('accepts exact authority, denied access and bounded revision-bearing commands', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(karavanMarketplaceAuthorityRequestSchema.parse(fixture.authorityRequest).chatId).toBe(
      '-9007199254740993',
    );
    expect(karavanMarketplaceAuthorityEvidenceSchema.parse(fixture.authorityEvidence)).toEqual(
      fixture.authorityEvidence,
    );
    expect(karavanMarketplaceActorAccessResponseSchema.parse(fixture.accessDenied).allowed).toBe(
      false,
    );
    expect(marketplaceManagementRequestSchema.parse(fixture.management)).toEqual(
      fixture.management,
    );
  });

  it('retains expired evidence as wire data without treating schema parsing as fresh authority', () => {
    expect(
      karavanMarketplaceAuthorityEvidenceSchema.parse(fixture.expiredAuthorityEvidence),
    ).toEqual(fixture.expiredAuthorityEvidence);
    expect(Date.parse(fixture.expiredAuthorityEvidence.expiresAt)).toBeLessThan(
      Date.parse(fixture.observedAt),
    );
  });

  it('rejects malformed expiry, access reasons, revisions, replay identity and unbounded operations', () => {
    for (const scenario of fixture.invalid) {
      expect(
        schemas[scenario.schema].safeParse({ ...inputs[scenario.schema], ...scenario.patch })
          .success,
        scenario.id,
      ).toBe(false);
    }
  });

  it('preserves canonical payload identity across key ordering and changes it for a new revision', () => {
    const parsed = marketplaceManagementRequestSchema.parse(fixture.management);
    const canonical = canonicalKaravanMarketplaceJson(parsed);
    expect(canonical).toBe(fixture.canonicalPayload);
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(fixture.payloadHash);
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    expect(canonicalKaravanMarketplaceJson(reordered)).toBe(canonical);
    const changed = {
      ...parsed,
      command: {
        operation: 'appearance_publish',
        input: { commandId: parsed.commandId, expectedRevision: fixture.actualRevision },
      },
    };
    expect(
      createHash('sha256').update(canonicalKaravanMarketplaceJson(changed)).digest('hex'),
    ).not.toBe(fixture.payloadHash);
  });
});
