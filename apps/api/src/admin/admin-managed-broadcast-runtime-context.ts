export type AdminManagedBroadcastRuntimeContext = {
  read(prop: PropertyKey): unknown;
  write(prop: PropertyKey, value: unknown): void;
};

export function createAdminManagedBroadcastRuntimeContext(
  target: object,
): AdminManagedBroadcastRuntimeContext {
  const targetRecord = target as Record<PropertyKey, unknown>;

  return {
    read(prop: PropertyKey): unknown {
      return targetRecord[prop];
    },
    write(prop: PropertyKey, value: unknown): void {
      targetRecord[prop] = value;
    },
  };
}
