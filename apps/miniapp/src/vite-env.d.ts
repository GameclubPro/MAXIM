/// <reference types="vite/client" />

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
};

declare global {
  interface Window {
    WebApp?: MaxWebAppBridge;
    MAX?: {
      WebApp?: MaxWebAppBridge;
    };
  }
}

export {};
