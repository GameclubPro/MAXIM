export type ChannelSuggestionImagePreparationRun = Readonly<{
  id: number;
}>;

export type ChannelSuggestionImagePreparationGuard = {
  tryStart: () => ChannelSuggestionImagePreparationRun | null;
  owns: (run: ChannelSuggestionImagePreparationRun) => boolean;
  finish: (run: ChannelSuggestionImagePreparationRun) => boolean;
  cancel: () => void;
  isActive: () => boolean;
};

export function createChannelSuggestionImagePreparationGuard(): ChannelSuggestionImagePreparationGuard {
  let nextId = 1;
  let activeRun: ChannelSuggestionImagePreparationRun | null = null;

  return {
    tryStart() {
      if (activeRun) {
        return null;
      }

      activeRun = { id: nextId };
      nextId += 1;
      return activeRun;
    },
    owns(run) {
      return activeRun === run;
    },
    finish(run) {
      if (activeRun !== run) {
        return false;
      }

      activeRun = null;
      return true;
    },
    cancel() {
      activeRun = null;
    },
    isActive() {
      return activeRun !== null;
    },
  };
}
