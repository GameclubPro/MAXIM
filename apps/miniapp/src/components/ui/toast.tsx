import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ToastTone } from './ui-types';
import { appendToast } from './toast-state';
import ToastStack from './toast-stack';

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
  replaceKey?: string;
};

export type ToastItem = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  durationMs: number;
  replaceKey?: string;
};

type ToastContextValue = {
  pushToast: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const removeToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    ({ title, description, tone = 'info', durationMs, replaceKey }: ToastInput) => {
      const id = idRef.current + 1;
      idRef.current = id;

      setToasts((current) =>
        appendToast(current, {
          id,
          title,
          description,
          tone,
          replaceKey,
          durationMs: durationMs ?? (tone === 'danger' ? 0 : description ? 6500 : 4000),
        }),
      );
    },
    [],
  );

  const value = useMemo(() => ({ pushToast }), [pushToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? <ToastStack toasts={toasts} onDismiss={removeToast} /> : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }

  return context;
}
