export type ChannelAudienceObservation = {
  capturedAt: Date;
  participantsCount: number | null;
};

export function mergeChannelAudienceObservations(
  native: ChannelAudienceObservation[],
  supplemental: ChannelAudienceObservation[],
  to: Date,
): ChannelAudienceObservation[] {
  const byTime = new Map<number, ChannelAudienceObservation>();
  // FLAG: Equal-time native observations win; point observations never add audiences.
  for (const row of [...supplemental, ...native]) {
    const at = row.capturedAt.getTime();
    if (
      Number.isFinite(at) &&
      at <= to.getTime() &&
      Number.isSafeInteger(row.participantsCount) &&
      (row.participantsCount ?? -1) >= 0
    )
      byTime.set(at, row);
  }
  return [...byTime.values()].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
}
