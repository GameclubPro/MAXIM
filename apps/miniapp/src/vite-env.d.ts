/// <reference types="vite/client" />

type MaxWebAppBridge = {
  initData?: string;
  init_data?: string;
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
