export type AdminChatRulesTextRuntimeContext = {
  read(prop: PropertyKey): unknown;
  write(prop: PropertyKey, value: unknown): void;
};

export function createAdminChatRulesTextRuntimeContext(
  target: object,
): AdminChatRulesTextRuntimeContext {
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
