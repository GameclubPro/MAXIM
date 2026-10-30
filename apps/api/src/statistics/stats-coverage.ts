import type { StatsCoverage } from '@maxim/contracts/statistics-central';
import { compareTimes } from './stats-common';

/** Preserve the wire/SQL microseconds: millisecond Date conversion can invent complete coverage. */
export function unionStatsCoverage(
  intervals: StatsCoverage['intervals'],
  from: string,
  to: string,
): StatsCoverage['intervals'] {
  const sorted = intervals
    .map((interval) => ({
      from: compareTimes(interval.from, from) > 0 ? interval.from : from,
      to: compareTimes(interval.to, to) < 0 ? interval.to : to,
    }))
    .filter((interval) => compareTimes(interval.from, interval.to) < 0)
    .sort((a, b) => compareTimes(a.from, b.from));
  const merged: StatsCoverage['intervals'] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && compareTimes(interval.from, last.to) <= 0) {
      if (compareTimes(interval.to, last.to) > 0) last.to = interval.to;
    } else merged.push({ ...interval });
  }
  return merged;
}
