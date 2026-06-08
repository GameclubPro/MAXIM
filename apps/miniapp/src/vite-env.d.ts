/// <reference types="vite/client" />

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_API_FALLBACK_BASES?: string;
  readonly VITE_PUBLIC_BASE_PATH?: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_APP_DESCRIPTION?: string;
  readonly VITE_APP_CANONICAL_URL?: string;
}

type MaxWebAppBridge = {
  version?: string;
  platform?: string;
  initData?: string;
  init_data?: string;
  initDataUnsafe?: {
    start_param?: string;
  };
  init_data_unsafe?: {
    start_param?: string;
  };
  startParam?: string;
  start_param?: string;
  ready?: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
  downloadFile?: (url: string, fileName: string) => Promise<{ status?: string }> | void;
  shareContent?: (payload: { text?: string; link?: string }) => Promise<{ status?: string }> | void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  isClosingConfirmationEnabled?: boolean;
  BackButton?: {
    isVisible?: boolean;
    show?: () => void;
    hide?: () => void;
    onClick?: (callback: () => void) => void;
    offClick?: (callback: () => void) => void;
  };
  HapticFeedback?: {
    impactOccurred?: (style?: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged?: () => void;
  };
  shareMaxContent?: (
    payload:
      | {
          text?: string;
          link?: string;
        }
      | {
          mid: string;
          chatType?: 'DIALOG' | 'CHAT';
        },
  ) => Promise<unknown> | void;
  DeviceStorage?: {
    getItem?: (key: string) => Promise<{ key?: string; value?: string | null }>;
    setItem?: (key: string, value: string) => Promise<{ status?: string }>;
    removeItem?: (key: string) => Promise<{ status?: string }>;
    clear?: () => Promise<{ status?: string }> | void;
  };
  SecureStorage?: {
    getItem?: (key: string) => Promise<{ key?: string; value?: string | null }>;
    setItem?: (key: string, value: string) => Promise<{ status?: string }>;
    removeItem?: (key: string) => Promise<{ status?: string }>;
    clear?: () => Promise<{ status?: string }> | void;
  };
};

declare global {
  const __MAXIM_API_FALLBACKS_ENABLED__: boolean | undefined;

  interface Window {
    WebApp?: MaxWebAppBridge;
    MAX?: {
      WebApp?: MaxWebAppBridge;
    };
  }
}

export {};
