import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import { getPublicationCalendarAvailability } from '../../lib/api/publication-client';
import {
  getPublicationTargetKey,
  type PublicationDraft,
  type PublicationEditorContext,
} from './publication-model';
import { addDays, getBroadcastPlannerWindow, startOfDay } from '../../lib/broadcast-planner-time';
import { publicationQueryKeys as queryKeys } from './publication-query-keys';
function getPublicationCalendarRange(now = new Date()): { from: string; to: string } {
  const { start, end } = getBroadcastPlannerWindow(now);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function usePublicationCalendar(
  api: ApiTransport,
  isEditor: boolean,
  draft: Pick<PublicationDraft, 'targets' | 'timingMode'>,
  editorContext: PublicationEditorContext | null,
) {
  const [calendarRange, setCalendarRange] = useState(() => getPublicationCalendarRange());
  const calendarTargetsKey = useMemo(
    () =>
      draft.targets
        .map((target) => getPublicationTargetKey(target))
        .sort((left, right) => left.localeCompare(right))
        .join(','),
    [draft.targets],
  );
  const calendarExcludePublicationId =
    editorContext?.kind === 'edit' || editorContext?.kind === 'import'
      ? editorContext.publicationId
      : null;
  const calendarAvailabilityQuery = useQuery({
    queryKey: queryKeys.calendar(
      calendarTargetsKey,
      calendarExcludePublicationId,
      calendarRange.from,
      calendarRange.to,
    ),
    queryFn: () =>
      getPublicationCalendarAvailability(api, {
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: draft.targets.map((target) => ({
            chatId: target.id,
            entityType: target.entityType,
          })),
        },
        from: calendarRange.from,
        to: calendarRange.to,
        ...(calendarExcludePublicationId
          ? { excludePublicationId: calendarExcludePublicationId }
          : {}),
      }),
    enabled: isEditor && draft.timingMode === 'schedule' && draft.targets.length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!isEditor) {
      return undefined;
    }

    let timeoutId: number | undefined;
    const refreshCalendarRange = () => {
      const nextRange = getPublicationCalendarRange();
      setCalendarRange((currentRange) =>
        currentRange.from === nextRange.from && currentRange.to === nextRange.to
          ? currentRange
          : nextRange,
      );
    };
    const scheduleNextRefresh = () => {
      refreshCalendarRange();
      const now = new Date();
      const nextDay = startOfDay(addDays(now, 1));
      timeoutId = window.setTimeout(
        scheduleNextRefresh,
        Math.max(1_000, nextDay.getTime() - now.getTime() + 1_000),
      );
    };
    const handleWindowFocus = () => refreshCalendarRange();

    scheduleNextRefresh();
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [isEditor]);
  return calendarAvailabilityQuery;
}
