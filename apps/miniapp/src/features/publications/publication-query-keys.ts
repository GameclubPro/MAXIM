import type { ListLegacyPublicationsQuery } from '@maxim/contracts/publication';
import type {
  PublicationView,
  PublicationEntityFilter,
  PublicationStatusFilter,
} from './publication-model';
type LegacyPublicationView = ListLegacyPublicationsQuery['view'];
type LegacyPublicationKindFilter = ListLegacyPublicationsQuery['kind'];

export const publicationQueryKeys = {
  listRoot: ['publications', 'list'] as const,
  list: (
    view: PublicationView,
    query: string,
    entityFilter: PublicationEntityFilter,
    statusFilter: PublicationStatusFilter,
  ) => ['publications', 'list', view, query, entityFilter, statusFilter] as const,
  legacyProbe: (view: LegacyPublicationView) => ['publications', 'legacy', 'probe', view] as const,
  legacyList: (
    view: LegacyPublicationView,
    query: string,
    kind: LegacyPublicationKindFilter,
    entityFilter: PublicationEntityFilter,
  ) => ['publications', 'legacy', 'list', view, query, kind, entityFilter] as const,
  calendar: (targetsKey: string, excludePublicationId: string | null, from: string, to: string) =>
    ['publications', 'calendar', targetsKey, excludePublicationId, from, to] as const,
};
