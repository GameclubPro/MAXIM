import type { ListLegacyPublicationsQuery } from '@maxim/contracts/publication';
import type {
  PublicationEntityFilter,
  PublicationStatusFilter,
  PublicationView,
} from './publication-model';

type LegacyView = ListLegacyPublicationsQuery['view'];
type LegacyKind = ListLegacyPublicationsQuery['kind'];

export const PUBLICATION_VIEW_OPTIONS: Array<{ value: PublicationView; label: string }> = [
  { value: 'current', label: 'Текущие' },
  { value: 'schedules', label: 'Расписания' },
  { value: 'history', label: 'История' },
];

export const PUBLICATION_ENTITY_FILTERS: Array<{
  value: PublicationEntityFilter;
  label: string;
}> = [
  { value: 'all', label: 'Все' },
  { value: 'chat', label: 'Чаты' },
  { value: 'channel', label: 'Каналы' },
];

export const LEGACY_PUBLICATION_VIEW_OPTIONS: Array<{ value: LegacyView; label: string }> = [
  { value: 'active', label: 'Активные' },
  { value: 'history', label: 'История' },
];

export const LEGACY_PUBLICATION_KIND_FILTERS: Array<{ value: LegacyKind; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'autopost', label: 'Автопосты' },
  { value: 'broadcast', label: 'Отправки' },
];

export const PUBLICATION_STATUS_FILTERS: Record<
  PublicationView,
  Array<{ value: PublicationStatusFilter; label: string }>
> = {
  current: [
    { value: 'all', label: 'Все статусы' },
    { value: 'active', label: 'Активные' },
    { value: 'paused', label: 'На паузе' },
    { value: 'failed', label: 'С ошибкой' },
  ],
  schedules: [
    { value: 'all', label: 'Все статусы' },
    { value: 'active', label: 'Активные' },
    { value: 'paused', label: 'На паузе' },
    { value: 'failed', label: 'С ошибкой' },
  ],
  history: [
    { value: 'all', label: 'Вся история' },
    { value: 'completed', label: 'Завершённые и отменённые' },
  ],
};

export const PUBLICATION_WEEKDAYS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 7, label: 'Вс' },
] as const;

const PUBLISHER_ONLY_PUBLICATION_ROUTE_PARAMS = [
  'compose',
  'draft',
  'entityId',
  'entityType',
  'import',
  'sourceId',
  'sourceType',
] as const;

export function stripPublisherOnlyPublicationRouteParams(
  searchParams: URLSearchParams,
): URLSearchParams | null {
  if (!PUBLISHER_ONLY_PUBLICATION_ROUTE_PARAMS.some((key) => searchParams.has(key))) {
    return null;
  }
  const next = new URLSearchParams(searchParams);
  PUBLISHER_ONLY_PUBLICATION_ROUTE_PARAMS.forEach((key) => next.delete(key));
  return next;
}
