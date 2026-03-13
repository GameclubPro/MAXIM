/// <reference types="vite/client" />

type MaxWebAppBridge = {
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
  openMaxLink?: (url: string) => void;
  shareMaxContent?: (payload: {
    mid: string;
    chatType?: 'DIALOG' | 'CHAT';
  }) => Promise<unknown> | void;
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
