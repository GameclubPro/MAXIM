import {
  chatSummarySchema as rootChatSummarySchema,
  managedEntityHeaderSchema as rootManagedEntityHeaderSchema,
  updateManagedEntityFavoritesRequestSchema as rootUpdateManagedEntityFavoritesRequestSchema,
} from '@maxim/contracts';
import {
  chatSummarySchema,
  managedEntityHeaderSchema,
  updateManagedEntityFavoritesRequestSchema,
} from '@maxim/contracts/managed-entities';

describe('managed entities contract exports', () => {
  it('keeps root and subpath exports aligned', () => {
    expect(rootChatSummarySchema).toBe(chatSummarySchema);
    expect(rootManagedEntityHeaderSchema).toBe(managedEntityHeaderSchema);
    expect(rootUpdateManagedEntityFavoritesRequestSchema).toBe(
      updateManagedEntityFavoritesRequestSchema,
    );
  });

  it('deduplicates favorite filters while preserving the submitted order', () => {
    const result = updateManagedEntityFavoritesRequestSchema.parse({
      favoriteTypes: ['broadcast', 'important', 'broadcast', 'service', 'important'],
    });

    expect(result.favoriteTypes).toEqual(['broadcast', 'important', 'service']);
  });
});
