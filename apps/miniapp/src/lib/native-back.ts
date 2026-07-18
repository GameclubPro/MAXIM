import { useEffect, useState } from 'react';

type NativeBackHandler = () => boolean;

type NativeBackEntry = {
  id: number;
  priority: number;
  handler: NativeBackHandler;
};

export const NATIVE_BACK_MODAL_CONFIRM_PRIORITY = 740;

let nextEntryId = 1;
const nativeBackEntries = new Map<number, NativeBackEntry>();
const nativeBackListeners = new Set<() => void>();

function notifyNativeBackListeners(): void {
  for (const listener of nativeBackListeners) {
    listener();
  }
}

export function registerNativeBackHandler(
  handler: NativeBackHandler,
  options: {
    priority?: number;
  } = {},
): () => void {
  const entry: NativeBackEntry = {
    id: nextEntryId,
    priority: options.priority ?? 0,
    handler,
  };
  nextEntryId += 1;
  nativeBackEntries.set(entry.id, entry);
  notifyNativeBackListeners();

  return () => {
    nativeBackEntries.delete(entry.id);
    notifyNativeBackListeners();
  };
}

export function hasNativeBackHandlers(): boolean {
  return nativeBackEntries.size > 0;
}

export function useNativeBackHandlersAvailable(): boolean {
  const [available, setAvailable] = useState(() => hasNativeBackHandlers());

  useEffect(() => {
    const handleChange = () => {
      setAvailable(hasNativeBackHandlers());
    };

    nativeBackListeners.add(handleChange);
    handleChange();

    return () => {
      nativeBackListeners.delete(handleChange);
    };
  }, []);

  return available;
}

export function runNativeBackHandlers(): boolean {
  const entries = Array.from(nativeBackEntries.values()).sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }

    return right.id - left.id;
  });

  for (const entry of entries) {
    if (entry.handler()) {
      return true;
    }
  }

  return false;
}

export function useNativeBackHandler(
  handler: NativeBackHandler,
  options: {
    enabled?: boolean;
    priority?: number;
  } = {},
): void {
  const enabled = options.enabled ?? true;
  const priority = options.priority ?? 0;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    return registerNativeBackHandler(handler, { priority });
  }, [enabled, handler, priority]);
}
