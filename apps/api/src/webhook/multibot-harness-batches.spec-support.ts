// FLAG: Local fixture accounting must not exceed the PostgreSQL bind limit as
// mirrored receipts accumulate. Keep each read bounded and preserve every ID.
export async function collectFixtureBatches<T>(
  ids: readonly string[],
  read: (batch: string[]) => Promise<readonly T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 1_000) {
    rows.push(...(await read(ids.slice(offset, offset + 1_000))));
  }
  return rows;
}

export async function countFixtureBatches(
  ids: readonly string[],
  read: (batch: string[]) => Promise<number>,
): Promise<number> {
  const counts = await collectFixtureBatches(ids, async (batch) => [await read(batch)]);
  return counts.reduce((sum, count) => sum + count, 0);
}
