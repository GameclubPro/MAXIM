import type {
  ManagedEntityFavoriteType,
  ManagedEntityNetworkEntriesResponse,
  ManagedEntityNetworksResponse,
  ManagedEntityType,
} from '@maxim/contracts';

function invalid(): never {
  throw new Error('Invalid managed entity networks response');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, minimum = 0, maximum = Infinity, trim = false): string {
  if (typeof value !== 'string') return invalid();
  const result = trim ? value.trim() : value;
  if (result.length < minimum || result.length > maximum) return invalid();
  return result;
}
function count(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    return invalid();
  return value;
}
function type(value: unknown): ManagedEntityType {
  if (value !== 'chat' && value !== 'channel') return invalid();
  return value;
}
function favorite(value: unknown): ManagedEntityFavoriteType {
  if (
    value !== 'important' &&
    value !== 'watch' &&
    value !== 'broadcast' &&
    value !== 'test' &&
    value !== 'partner' &&
    value !== 'service'
  )
    return invalid();
  return value;
}
function nullableFavorite(value: unknown) {
  return value === null ? null : favorite(value);
}
function items(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}
function label(value: unknown): string {
  const result = text(value).replace(/\s+/gu, ' ').trim();
  if (!result || result.includes('\u0000') || Array.from(result).length > 24) return invalid();
  return result;
}

// FLAG: Keep these focused wire parsers equivalent to the canonical response schemas.
// Home loads full favorite assignments before a network editor is opened.
export function parseManagedEntityNetworksResponse(value: unknown): ManagedEntityNetworksResponse {
  const source = record(value);
  const cards = items(source.items, 6);
  if (cards.length !== 6) return invalid();
  return {
    entityType: type(source.entityType),
    compositionVersion: text(source.compositionVersion, 1),
    labelsRevision: source.labelsRevision === null ? null : count(source.labelsRevision, 1),
    items: cards.map((value) => {
      const card = record(value);
      return {
        favoriteType: favorite(card.favoriteType),
        label: label(card.label),
        entityCount: count(card.entityCount),
        compositionVersion: text(card.compositionVersion, 1),
      };
    }),
  };
}

export function parseManagedEntityNetworkEntriesResponse(
  value: unknown,
): ManagedEntityNetworkEntriesResponse {
  const source = record(value);
  return {
    entityType: type(source.entityType),
    compositionVersion: text(source.compositionVersion, 1),
    items: items(source.items, 100).map((value) => {
      const entry = record(value);
      return {
        id: text(entry.id, 1, Infinity, true),
        entityType: type(entry.entityType),
        title: text(entry.title),
        avatarUrl: entry.avatarUrl === null ? null : text(entry.avatarUrl),
        favoriteType: nullableFavorite(entry.favoriteType),
      };
    }),
    nextCursor: source.nextCursor === null ? null : text(source.nextCursor),
  };
}

export {
  invalid as invalidNetworkResponse,
  record as networkResponseRecord,
  text as networkResponseText,
  type as networkResponseEntityType,
  nullableFavorite as networkResponseNullableFavorite,
  items as networkResponseItems,
};
