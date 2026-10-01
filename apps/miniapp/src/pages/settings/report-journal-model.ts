import type { ReportDetail, ReportSummary, ReportsPage } from '@maxim/contracts/settings';

export type ObservedReport = ReportSummary & { observedAt?: string };
export const isReportActive = (item: ReportSummary | undefined) =>
  Boolean(item && ['COLLECTING', 'PENDING', 'RUNNING'].includes(item.status));

// FLAG: A delayed detail response must not restore an obsolete status or dismissal action.
export function newestReport<T extends ObservedReport>(left: T, right?: T): T {
  if (!right || right.id !== left.id) return left;
  const versionDelta = (right.contentVersion ?? 0) - (left.contentVersion ?? 0);
  if (versionDelta) return versionDelta > 0 ? right : left;
  const updatedDelta =
    Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt);
  if (updatedDelta) return updatedDelta > 0 ? right : left;
  const observedDelta =
    Date.parse(right.observedAt ?? right.createdAt) - Date.parse(left.observedAt ?? left.createdAt);
  return observedDelta >= 0 ? right : left;
}

export function mergeReportPages(pages: ReportsPage[]): ObservedReport[] {
  const rows = new Map<string, ObservedReport>();
  for (const page of pages) {
    for (const item of page.items) {
      const observed = { ...item, observedAt: page.observedAt };
      rows.set(item.id, newestReport(observed, rows.get(item.id)));
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

export function reportDetailsMatch(summary: ObservedReport, detail?: ReportDetail): boolean {
  return Boolean(
    detail &&
    detail.id === summary.id &&
    (summary.snapshotVersion && detail.snapshotVersion
      ? summary.snapshotVersion === detail.snapshotVersion
      : newestReport(summary, detail) === detail),
  );
}
