import { describe, expect, it } from 'vitest';
import {
  managedEntityNetworkEntriesQuerySchema,
  updateManagedEntityNetworkCompositionRequestSchema,
} from '../src/managed-entities.js';

describe('managed entity network boundary', () => {
  it('requires an expected assignment and rejects duplicate entity changes', () => {
    const change = { entityId: '1', expectedFavoriteType: null, favoriteType: 'watch' };
    expect(
      updateManagedEntityNetworkCompositionRequestSchema.parse({ changes: [change] }).changes,
    ).toEqual([change]);
    expect(() =>
      updateManagedEntityNetworkCompositionRequestSchema.parse({
        changes: [{ entityId: '1', favoriteType: 'watch' }],
      }),
    ).toThrow();
    expect(() =>
      updateManagedEntityNetworkCompositionRequestSchema.parse({ changes: [change, change] }),
    ).toThrow();
    expect(() =>
      updateManagedEntityNetworkCompositionRequestSchema.parse({
        changes: [change],
        replaceAll: true,
      }),
    ).toThrow();
  });
  it('keeps query pages bounded and parses explicit boolean filters without truthiness coercion', () => {
    expect(
      managedEntityNetworkEntriesQuerySchema.parse({ favoritesOnly: 'false' }).favoritesOnly,
    ).toBe(false);
    expect(
      managedEntityNetworkEntriesQuerySchema.parse({ favoritesOnly: 'true', limit: '100' }).limit,
    ).toBe(100);
    expect(() => managedEntityNetworkEntriesQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() =>
      managedEntityNetworkEntriesQuerySchema.parse({ favoriteType: 'unknown' }),
    ).toThrow();
  });
});
