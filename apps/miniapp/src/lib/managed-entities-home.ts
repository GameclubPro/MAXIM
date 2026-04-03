type ManagedTab = 'chat' | 'channel';

type ManagedEntityListItem = {
  id: string;
  title: string;
};

export type VisibleLaunchContext = {
  tab: ManagedTab;
  chatId: string;
};

export function buildManagedEntitiesHomeView<T extends ManagedEntityListItem>(options: {
  entities: readonly T[] | null | undefined;
  query: string;
  activeTab: ManagedTab;
  visibleLaunchContext: VisibleLaunchContext | null;
}) {
  const entities = Array.isArray(options.entities) ? [...options.entities] : [];
  const normalizedQuery = options.query.trim().toLowerCase();
  const matchingEntities =
    normalizedQuery.length === 0
      ? entities
      : entities.filter((entity) => {
          const haystack = `${entity.title} ${entity.id}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        });

  const hasVisibleLaunchContext = options.visibleLaunchContext?.tab === options.activeTab;
  const listEntities = hasVisibleLaunchContext
    ? matchingEntities.filter((entity) => entity.id !== options.visibleLaunchContext?.chatId)
    : matchingEntities;

  return {
    listEntities,
    visibleCount: listEntities.length + (hasVisibleLaunchContext ? 1 : 0),
    hasVisibleLaunchContext,
  };
}
