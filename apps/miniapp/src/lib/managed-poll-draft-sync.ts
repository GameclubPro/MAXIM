export type ManagedPollDraftSyncState<TPayload> = {
  payload: TPayload | null;
  payloadKey: string;
  isDirty: boolean;
  isActive: boolean;
  lastFailedKey: string | null;
};

export type ManagedPollDraftSyncHandlers<TPayload, TResult> = {
  readState: () => ManagedPollDraftSyncState<TPayload>;
  getInFlightSave: () => Promise<TResult> | null;
  setInFlightSave: (promise: Promise<TResult> | null) => void;
  onBlockedByLastFailure?: (payloadKey: string) => void;
  onSaveStart?: () => void;
  onSaveSuccess?: (result: TResult, payloadKey: string) => void;
  onSaveError?: (error: unknown, payloadKey: string) => void;
  performSave: (payload: TPayload) => Promise<TResult>;
};

export function buildManagedPollDraftKey<TDraft>(draft: TDraft): string {
  return JSON.stringify(draft);
}

export function shouldReplaceLocalManagedPollDraft(params: {
  entityChanged: boolean;
  hasCurrentDraft: boolean;
  isDirty: boolean;
  currentDraftKey: string;
  nextDraftKey: string;
}): boolean {
  if (params.entityChanged || !params.hasCurrentDraft) {
    return true;
  }

  return !params.isDirty || params.currentDraftKey === params.nextDraftKey;
}

export async function syncManagedPollDraft<TPayload, TResult>(
  handlers: ManagedPollDraftSyncHandlers<TPayload, TResult>,
  options: {
    force?: boolean;
  } = {},
): Promise<TResult | null> {
  const force = options.force === true;

  while (true) {
    const state = handlers.readState();
    if (!state.payload || state.isActive || (!force && !state.isDirty)) {
      return null;
    }

    if (!force && state.payloadKey === state.lastFailedKey) {
      handlers.onBlockedByLastFailure?.(state.payloadKey);
      return null;
    }

    const inFlightSave = handlers.getInFlightSave();
    if (inFlightSave) {
      if (!force) {
        return inFlightSave;
      }

      try {
        await inFlightSave;
      } catch {
        // Explicit publish retries after a failed autosave.
      }
      if (handlers.getInFlightSave() === inFlightSave) {
        handlers.setInFlightSave(null);
      }
      continue;
    }

    handlers.onSaveStart?.();

    const payloadKey = state.payloadKey;
    const request = handlers
      .performSave(state.payload)
      .then((result) => {
        handlers.onSaveSuccess?.(result, payloadKey);
        return result;
      })
      .catch((error: unknown) => {
        handlers.onSaveError?.(error, payloadKey);
        throw error;
      })
      .finally(() => {
        handlers.setInFlightSave(null);
      });

    handlers.setInFlightSave(request);
    return request;
  }
}
