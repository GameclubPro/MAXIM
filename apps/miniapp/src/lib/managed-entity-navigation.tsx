import {
  Suspense,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  UNSAFE_NavigationContext,
  useLocation,
  useNavigate,
  type NavigateOptions,
  type Navigator,
  type To,
} from 'react-router';
import {
  decideManagedEntityWorkspaceBack,
  readManagedEntityWorkspaceState,
} from './managed-entity-workspace';
import {
  ManagedEntityNavigationContext,
  registerManagedEntityPopStateHandler,
  type ManagedEntityGuardGetter,
  type ManagedEntityLeaveGuard,
  type ManagedEntityNavigationContextValue,
} from './managed-entity-navigation-context';

export { useManagedEntityNavigation } from './managed-entity-navigation-context';
export type { ManagedEntityLeaveGuard } from './managed-entity-navigation-context';

const LazyActionConfirmSheet = lazy(async () => {
  const module = await import('../components/ui/action-confirm-sheet');
  return { default: module.ActionConfirmSheet };
});

type PendingNavigation = {
  run: () => void;
};

function readHistoryIndex(state: unknown = window.history.state): number | null {
  if (typeof state !== 'object' || state === null || !('idx' in state)) {
    return null;
  }

  const value = state.idx;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readTargetPathname(to: To, currentPathname: string): string | null {
  if (typeof to !== 'string') {
    return to.pathname ?? currentPathname;
  }

  const pathname = to.split(/[?#]/u, 1)[0];
  if (!pathname) {
    return currentPathname;
  }

  return pathname.startsWith('/') ? pathname : null;
}

export function ManagedEntityNavigationProvider({ children }: { children: ReactNode }) {
  const parentNavigationContext = useContext(UNSAFE_NavigationContext);
  const location = useLocation();
  const navigate = useNavigate();
  const guardGetterRef = useRef<ManagedEntityGuardGetter | null>(null);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const restorePopDeltaRef = useRef<number | null>(null);
  const bypassNextPopRef = useRef(false);
  const currentHistoryIndexRef = useRef(readHistoryIndex());
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [, setGuardRevision] = useState(0);

  if (!parentNavigationContext) {
    throw new Error('ManagedEntityNavigationProvider must be used inside a router');
  }

  useLayoutEffect(() => {
    const historyIndex = readHistoryIndex();
    if (historyIndex !== null) {
      currentHistoryIndexRef.current = historyIndex;
    }
  }, [location.key]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!guardGetterRef.current?.().dirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useLayoutEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const nextHistoryIndex = readHistoryIndex(event.state);

      if (bypassNextPopRef.current) {
        bypassNextPopRef.current = false;
        if (nextHistoryIndex !== null) {
          currentHistoryIndexRef.current = nextHistoryIndex;
        }
        return;
      }

      const restoredDelta = restorePopDeltaRef.current;
      if (restoredDelta !== null) {
        event.stopImmediatePropagation();
        restorePopDeltaRef.current = null;
        if (nextHistoryIndex !== null) {
          currentHistoryIndexRef.current = nextHistoryIndex;
        }
        pendingNavigationRef.current = {
          run: () => {
            bypassNextPopRef.current = true;
            window.history.go(restoredDelta);
          },
        };
        setConfirmationOpen(true);
        return;
      }

      const currentHistoryIndex = currentHistoryIndexRef.current;
      if (
        !guardGetterRef.current?.().dirty ||
        currentHistoryIndex === null ||
        nextHistoryIndex === null
      ) {
        if (nextHistoryIndex !== null) {
          currentHistoryIndexRef.current = nextHistoryIndex;
        }
        return;
      }

      const delta = nextHistoryIndex - currentHistoryIndex;
      if (delta === 0) {
        return;
      }

      event.stopImmediatePropagation();
      restorePopDeltaRef.current = delta;
      window.history.go(-delta);
    };

    return registerManagedEntityPopStateHandler(handlePopState);
  }, []);

  const registerLeaveGuard = useCallback((getGuard: ManagedEntityGuardGetter) => {
    guardGetterRef.current = getGuard;
    return () => {
      if (guardGetterRef.current === getGuard) {
        guardGetterRef.current = null;
      }
    };
  }, []);

  const notifyLeaveGuardChanged = useCallback(() => {
    setGuardRevision((revision) => (revision + 1) % Number.MAX_SAFE_INTEGER);
  }, []);

  const runOrQueueNavigation = useCallback(
    (run: () => void, targetPathname: string | null) => {
      const guard = guardGetterRef.current?.();
      if (!guard?.dirty || targetPathname === location.pathname) {
        run();
        return true;
      }

      if (!pendingNavigationRef.current) {
        pendingNavigationRef.current = { run };
        setConfirmationOpen(true);
      }
      return false;
    },
    [location.pathname],
  );

  const requestNavigation = useCallback(
    (to: To, options?: NavigateOptions) =>
      runOrQueueNavigation(
        () => navigate(to, options),
        readTargetPathname(to, location.pathname),
      ),
    [location.pathname, navigate, runOrQueueNavigation],
  );

  const requestBack = useCallback(
    (fallbackTo: To) => {
      const workspace = readManagedEntityWorkspaceState(location.state);
      const decision = decideManagedEntityWorkspaceBack({
        origin: workspace?.origin,
        currentLocationKey: location.key,
        currentHistoryIndex: readHistoryIndex(),
      });
      if (decision === 'history-back') {
        runOrQueueNavigation(() => {
          bypassNextPopRef.current = true;
          navigate(-1);
        }, null);
        return;
      }

      requestNavigation(fallbackTo, { replace: true });
    },
    [location.key, location.state, navigate, requestNavigation, runOrQueueNavigation],
  );

  const guardedNavigator = useMemo<Navigator>(() => {
    const navigator = parentNavigationContext.navigator;
    return {
      createHref: navigator.createHref,
      encodeLocation: navigator.encodeLocation,
      go: (delta) => {
        if (delta === 0) {
          navigator.go(delta);
          return;
        }
        runOrQueueNavigation(() => {
          bypassNextPopRef.current = true;
          navigator.go(delta);
        }, null);
      },
      push: (to, state, options) => {
        runOrQueueNavigation(
          () => navigator.push(to, state, options),
          readTargetPathname(to, location.pathname),
        );
      },
      replace: (to, state, options) => {
        runOrQueueNavigation(
          () => navigator.replace(to, state, options),
          readTargetPathname(to, location.pathname),
        );
      },
    };
  }, [location.pathname, parentNavigationContext.navigator, runOrQueueNavigation]);

  const guardedNavigationContext = useMemo(
    () => ({ ...parentNavigationContext, navigator: guardedNavigator }),
    [guardedNavigator, parentNavigationContext],
  );
  const value = useMemo<ManagedEntityNavigationContextValue>(
    () => ({ notifyLeaveGuardChanged, registerLeaveGuard, requestBack, requestNavigation }),
    [notifyLeaveGuardChanged, registerLeaveGuard, requestBack, requestNavigation],
  );
  const activeGuard = guardGetterRef.current?.() ?? null;
  const busy = savePending || Boolean(activeGuard?.saving);

  const closeConfirmation = () => {
    if (busy) {
      return;
    }
    pendingNavigationRef.current = null;
    setConfirmationOpen(false);
  };

  const saveAndProceed = async () => {
    const guard = guardGetterRef.current?.();
    const pendingNavigation = pendingNavigationRef.current;
    if (!guard || !pendingNavigation) {
      return;
    }

    setSavePending(true);
    try {
      if (await guard.save()) {
        pendingNavigationRef.current = null;
        setConfirmationOpen(false);
        pendingNavigation.run();
      }
    } finally {
      setSavePending(false);
    }
  };

  const discardAndProceed = () => {
    const guard = guardGetterRef.current?.();
    const pendingNavigation = pendingNavigationRef.current;
    if (!guard || !pendingNavigation || busy) {
      return;
    }

    guard.discard();
    pendingNavigationRef.current = null;
    setConfirmationOpen(false);
    pendingNavigation.run();
  };

  return (
    <ManagedEntityNavigationContext.Provider value={value}>
      <UNSAFE_NavigationContext.Provider value={guardedNavigationContext}>
        {children}
      </UNSAFE_NavigationContext.Provider>
      {confirmationOpen ? (
        <Suspense fallback={null}>
          <LazyActionConfirmSheet
            id="managed-entity-leave-confirm"
            open
            title="Сохранить изменения?"
            summary="Перед переходом можно сохранить текущие настройки или выйти без изменений."
            confirmLabel="Сохранить и перейти"
            confirmBusyLabel="Сохраняем..."
            cancelLabel="Отмена"
            tone="accent"
            isBusy={busy}
            extraActionLabel="Выйти без сохранения"
            extraActionTone="danger"
            actionOrder="confirm-extra-cancel"
            onClose={closeConfirmation}
            onConfirm={() => void saveAndProceed()}
            onExtraAction={discardAndProceed}
          />
        </Suspense>
      ) : null}
    </ManagedEntityNavigationContext.Provider>
  );
}

export function useManagedEntityLeaveGuard(guard: ManagedEntityLeaveGuard): void {
  const context = useContext(ManagedEntityNavigationContext);
  const guardRef = useRef(guard);
  guardRef.current = guard;

  useEffect(() => {
    if (!context) {
      return undefined;
    }

    return context.registerLeaveGuard(() => guardRef.current);
  }, [context]);

  useLayoutEffect(() => {
    context?.notifyLeaveGuardChanged();
  }, [context, guard.dirty, guard.saving]);
}
