import { describe, it, expect } from 'vitest';
import {
  marketplaceEditorialMutationSchema,
  marketplaceEditorialProofSchema,
  marketplaceEditorialStateSchema,
} from '../src/marketplace-integration.js';
const uuid = '00000000-0000-4000-8000-000000000001';
const mutation = {
  requestId: uuid,
  listingId: uuid,
  ownershipKey: 'a'.repeat(64),
  expectedRevision: 1,
  description: 'Описание',
};
const proof = {
  version: 1,
  scope: 'PROFILE_DESCRIPTION',
  requestId: uuid,
  actorUserId: '933001',
  entityId: '-100',
  kind: 'CHANNEL',
  profile: 'publisher',
  bindingId: uuid,
  bindingRevision: 1,
  state: 'ACTIVE',
  checkedAt: '2026-10-30T12:00:00.000Z',
  validUntil: '2026-10-30T12:00:30.000Z',
};
describe('separate shared-description boundaries', () => {
  it('accepts only a bounded description and mandatory CAS/owner identity', () => {
    expect(marketplaceEditorialMutationSchema.parse(mutation).description).toBe('Описание');
    for (const field of [
      'ownerId',
      'actorUserId',
      'price',
      'status',
      'statisticsConsent',
      'appendEnabled',
    ])
      expect(
        marketplaceEditorialMutationSchema.safeParse({ ...mutation, [field]: true }).success,
      ).toBe(false);
    for (const description of ['', ' '.repeat(5), '🙂'.repeat(751)])
      expect(
        marketplaceEditorialMutationSchema.safeParse({ ...mutation, description }).success,
      ).toBe(false);
    expect(
      marketplaceEditorialMutationSchema.safeParse({ ...mutation, expectedRevision: undefined })
        .success,
    ).toBe(false);
  });
  it('bounds proof expiry and rejects non-editorial scopes or private additions', () => {
    expect(marketplaceEditorialProofSchema.safeParse(proof).success).toBe(true);
    for (const extra of [
      { validUntil: '2026-10-30T12:00:31.000Z' },
      { checkedAt: null },
      { state: 'REVOKED' },
      { scope: 'STATISTICS' },
      { statisticsConsent: true },
    ])
      expect(marketplaceEditorialProofSchema.safeParse({ ...proof, ...extra }).success).toBe(false);
    expect(
      marketplaceEditorialProofSchema.safeParse({ ...proof, state: 'REVOKED', validUntil: null })
        .success,
    ).toBe(true);
  });
  it('cannot label an editor as commercially authorized', () => {
    const state = {
      version: 1,
      entityId: '-100',
      kind: 'CHANNEL',
      revision: 1,
      listing: { id: uuid, title: 'Площадка', description: '', profileOnly: true, publicUrl: null },
      ownershipKey: 'a'.repeat(64),
      role: 'EDITOR',
      responsible: { displayName: 'Ответственный', profileId: null },
      capabilities: { canEditDescription: true, canManageCommercial: false },
      validUntil: proof.validUntil,
    };
    expect(marketplaceEditorialStateSchema.safeParse(state).success).toBe(true);
    expect(
      marketplaceEditorialStateSchema.safeParse({
        ...state,
        capabilities: { canEditDescription: true, canManageCommercial: true },
      }).success,
    ).toBe(false);
  });
});
