/// <reference types="vite/client" />

declare global {
  interface Window {
    MAX?: {
      WebApp?: {
        initData?: string;
      };
    };
  }
}

export {};
