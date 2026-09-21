import type {
  ManagedEntityGuardGetter,
  ManagedEntityLeaveGuard,
} from './managed-entity-navigation-context';

export function combineManagedEntityLeaveGuards(
  getters: readonly ManagedEntityGuardGetter[],
): ManagedEntityLeaveGuard {
  return {
    dirty: getters.some((get) => get().dirty),
    saving: getters.some((get) => get().saving),
    async save() {
      for (const get of [...getters].reverse()) {
        const guard = get();
        if (guard.saving || (guard.dirty && !(await guard.save()))) return false;
      }
      return true;
    },
    discard() {
      for (const get of getters) if (get().dirty) get().discard();
    },
  };
}
