export type BotDialogHandoffOutcome = 'opened' | 'cancelled' | 'failed' | 'busy';

type ResolveBotDialogUrl = (signal: AbortSignal) => Promise<string | null>;
type OpenBotDialog = (url: string) => boolean;

export type BotDialogHandoffCoordinator = {
  run: (
    resolveUrl: ResolveBotDialogUrl,
    openDialog: OpenBotDialog,
  ) => Promise<BotDialogHandoffOutcome>;
  cancel: () => boolean;
};

export function createBotDialogHandoffCoordinator(): BotDialogHandoffCoordinator {
  let attempt = 0;
  let active = false;
  let controller: AbortController | null = null;

  return {
    async run(resolveUrl, openDialog) {
      if (active) {
        return 'busy';
      }

      active = true;
      const currentAttempt = ++attempt;
      const attemptController = new AbortController();
      controller = attemptController;

      try {
        const url = await resolveUrl(attemptController.signal);
        if (attemptController.signal.aborted || currentAttempt !== attempt) {
          return 'cancelled';
        }
        if (!url || !openDialog(url)) {
          active = false;
          controller = null;
          return 'failed';
        }

        // Keep the lock held until the mini app closes or the caller explicitly cancels.
        return 'opened';
      } catch {
        if (attemptController.signal.aborted || currentAttempt !== attempt) {
          return 'cancelled';
        }
        active = false;
        controller = null;
        return 'failed';
      }
    },
    cancel() {
      if (!active && !controller) {
        return false;
      }

      attempt += 1;
      controller?.abort();
      controller = null;
      active = false;
      return true;
    },
  };
}
